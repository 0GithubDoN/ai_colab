// MCP tools for the room. Used by every MCP-capable app: through the local
// stdio bridge (Claude desktop, Codex, Antigravity, Cursor, VS Code, Gemini
// CLI...) or over HTTP (ChatGPT / Claude.ai connectors through a public link).
//
// Apps resend every tool definition with every request, so the tool list is kept
// small and terse: related actions share one tool, and descriptions say only what
// a model needs to pick the right call.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { RoomError, RULES } from './room.js';
import { normalizeCode, VERSION, IMAGE_EXTS } from './util.js';
import { formatWait, compactJson } from './format.js';

const RO = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/**
 * ctx: { hub, roomCode?: string (fixed room for /r/<code>/mcp), local: boolean, token?: string,
 *        profile?: 'lite' (no file tools: for apps that have their own), defaultWait?: seconds }
 */
export function createMcpServer(ctx) {
  const { hub } = ctx;
  const server = new McpServer(
    { name: 'crewroom', version: VERSION },
    {
      instructions: [
        'Crewroom is a team room: several AI assistants from different apps work on one project together while their human watches a live dashboard.',
        'When the user gives you a Crewroom invite link or code (like ABCD-EFGH-JKLM), call join_room. Then loop: wait_for_updates -> act with your own tools -> report -> wait_for_updates.',
        'Split work: hand tasks to teammates (ask_member, to "auto:<skill>" picks a free one) instead of doing everything yourself. Keep messages short.',
        ...RULES,
      ].join('\n'),
    },
  );

  const who = () => {
    let found = ctx.token && hub.findMember(ctx.token);
    // The app restarted its connection (new process, hub update, expired session): if exactly
    // one member came from this app, it is this one coming back, so carry on without a rejoin.
    if (!found && !ctx.token) {
      const app = server.server.getClientVersion?.()?.name;
      const rooms = ctx.roomCode ? [hub.room(ctx.roomCode)].filter(Boolean) : hub.listRooms();
      const matches = app ? rooms.flatMap((room) => Object.values(room.s.members).filter((m) => m.client?.name === app).map((member) => ({ room, member }))) : [];
      if (matches.length === 1) {
        found = matches[0];
        ctx.token = found.member.token;
        ctx.resumed = `(Reconnected you as ${found.member.name} in room "${found.room.s.name}".) `;
      }
    }
    if (!found) throw new RoomError('Not joined (or the connection was reset). Call join_room again; pass your token to come back as the same member.', 401);
    return found;
  };

  const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : compactJson(obj) }] });
  const fail = (err) => ({ isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] });

  /** Run a room action for the joined member; `format` turns the result into text. Counts the tokens it costs. */
  const act = (action, mapArgs = (a) => a, format) => async (args = {}, extra) => {
    try {
      const { room, member } = who();
      const [name, mapped] = typeof action === 'function' ? action(args) : [action, mapArgs(args, extra)];
      const result = await room.call(name, member, mapped);
      const out = text(format ? format(result) : result);
      if (ctx.resumed) {
        out.content[0].text = ctx.resumed + out.content[0].text;
        ctx.resumed = null;
      }
      room.account(member, JSON.stringify(args).length, out.content[0].text.length);
      return out;
    } catch (err) {
      return fail(err);
    }
  };

  // Apps that edit files with their own tools (Claude Code, Codex, Antigravity, Cursor...) get
  // a lite set without the room's file tools: fewer definitions resent with every request.
  const LITE_SKIP = new Set(['list_files', 'read_file', 'search_files', 'project_changes', 'write_file', 'edit_file', 'restore_file', 'run_command']);
  // Small models make fewer mistakes with fewer tools: the minimal set is just the core loop.
  const MINIMAL = new Set(['join_room', 'wait_for_updates', 'send_message', 'update_task', 'read_messages', 'memory']);
  const tool = (name, description, shape, annotations, handler, meta) => {
    if (ctx.profile === 'lite' && LITE_SKIP.has(name)) return;
    if (ctx.profile === 'minimal' && !MINIMAL.has(name)) return;
    server.registerTool(name, { description, inputSchema: shape, annotations, ...(meta ? { _meta: meta } : {}) }, handler);
  };
  const defaultWait = Math.min(Math.max(Number(ctx.defaultWait) || 45, 5), 3600);
  // The style list is long and would be resent with every request; a wrong style returns it.
  const AVATAR_HINT = 'Picture: "style:seed", e.g. "lorelei:sunny" (a wrong style lists them all).';

  // ---------------- room ----------------

  tool(
    'join_room',
    'Join with the invite code or link. Rejoining (e.g. in a fresh chat)? Pass your token: you get back the summary, your checkpoint and your tasks.',
    {
      invite: z.string().optional().describe('Invite code (ABCD-EFGH-JKLM) or link.'),
      name: z.string().describe('Short name others @mention, e.g. "ChatGPT".'),
      app: z.string().optional().describe('App you run in.'),
      model: z.string().optional().describe('Your exact model, as far as you know it.'),
      capabilities: z.array(z.string()).optional().describe('e.g. image-generation, web-search, terminal.'),
      avatar: z.string().optional().describe(AVATAR_HINT),
      lead: z.boolean().optional().describe('Become lead if there is none.'),
      listen: z.enum(['focus', 'all']).optional().describe('Default: focus for members, all for the lead.'),
      token: z.string().optional().describe('Your token, to come back as yourself.'),
    },
    WRITE,
    async (args) => {
      try {
        let room = null;
        if (args.token) room = hub.findMember(args.token)?.room || null;
        if (!room && ctx.roomCode) room = hub.room(ctx.roomCode);
        if (!room && args.invite) {
          const code = normalizeCode(args.invite);
          if (!code) throw new RoomError('That does not look like a Crewroom invite code (ABCD-EFGH-JKLM, or a link containing /r/ABCD-EFGH-JKLM).');
          room = hub.room(code);
          if (!room) throw new RoomError('No room with that code is open on this computer. Ask the human to run "crewroom start" in the project folder (or check the code).', 404);
        }
        if (!room) {
          const open = hub.listRooms();
          if (ctx.local && open.length === 1) room = open[0];
          else if (!open.length) throw new RoomError('No room is open. Ask the human to run "crewroom start" in their project folder, then give you the invite code.', 404);
          else throw new RoomError('Which room? Ask the human for the invite code and pass it as "invite".');
        }
        // The app's real name and version, from the MCP handshake (the model can't misreport this one).
        const client = server.server.getClientVersion?.();
        const result = await room.call('join', null, { ...args, client, via: ctx.local ? 'mcp (local)' : 'mcp (public link)' });
        ctx.token = result.your_token;
        const out = text(result);
        room.account(room.memberByToken(result.your_token), JSON.stringify(args).length, out.content[0].text.length);
        return out;
      } catch (err) {
        return fail(err);
      }
    },
  );

  tool(
    'wait_for_updates',
    'New messages and tasks for you; waits up to timeout_seconds when nothing is new. Follow the "next:" line. Each check costs tokens, so wait as long as your app allows.',
    {
      timeout_seconds: z.number().optional().describe(`Default ${defaultWait}.`),
      include_history: z.number().optional().describe('Also return this many earlier messages.'),
    },
    RO,
    // Public links go through a tunnel that drops requests after ~100s, so keep those waits shorter.
    act('wait', (a, extra) => {
      const seconds = a.timeout_seconds ?? defaultWait;
      return { ...a, timeout_seconds: ctx.local ? seconds : Math.min(seconds, 90), signal: extra?.signal };
    }, formatWait),
  );

  tool('room_status', 'Members (status, model, usage), open tasks, files being edited, summary, decisions, notes, shared files.', {}, RO, act('status'));

  tool(
    'send_message',
    'Post to everyone, or to one member with "to" (name, "lead", "human"). @Name gets attention. react_to: react to message #seq with an emoji as text instead of replying "ok" (wakes nobody).',
    { text: z.string(), to: z.string().optional(), attachments: z.array(z.string()).optional().describe('Shared file ids.'), react_to: z.number().optional() },
    WRITE,
    act((a) => (a.react_to ? ['react', { seq: a.react_to, emoji: a.text }] : ['send', a])),
  );

  tool(
    'read_messages',
    'Earlier messages, or one message in full with seq.',
    { seq: z.number().optional(), limit: z.number().optional(), before_seq: z.number().optional(), from: z.string().optional() },
    RO,
    act((a) => (a.seq ? ['read_message', { seq: a.seq }] : ['read_messages', a])),
  );

  // ---------------- teamwork ----------------

  tool(
    'ask_member',
    'Give work to teammates; results come back to you. to: name(s), "auto" or "auto:<skill>" (picks by skill, rank, usage), or empty for anyone. Keep tasks small, with done_when and a check (runs on finish; a failure sends it back).',
    {
      title: z.string(),
      details: z.string().optional().describe('Instructions.'),
      done_when: z.string().optional().describe('Acceptance criteria.'),
      check: z.string().optional().describe('Command or toolbox name that verifies it, e.g. "npm test".'),
      difficulty: z.enum(['easy', 'normal', 'hard']).optional().describe('auto routing: hard -> top ranks, easy -> juniors.'),
      to: z.string().optional(),
      kind: z.enum(['task', 'review', 'fix', 'question', 'asset', 'research']).optional(),
      files: z.array(z.string()).optional(),
      wait_seconds: z.number().optional(),
    },
    WRITE,
    act('ask'),
  );

  tool(
    'update_task',
    'take (reserves its files) | done / blocked / cancel (result goes to the asker; the check runs first) | wait (for a task you gave) | diff (what changed) | review (verdict approve or changes, rating 1-5, note in result).',
    {
      task_id: z.string(),
      action: z.enum(['take', 'done', 'blocked', 'cancel', 'wait', 'diff', 'review']),
      result: z.string().optional(),
      verdict: z.enum(['approve', 'changes']).optional(),
      rating: z.number().optional(),
      attachments: z.array(z.string()).optional().describe('Shared file ids, e.g. an image you made.'),
      wait_seconds: z.number().optional(),
    },
    WRITE,
    act((a) => {
      if (a.action === 'take') return ['take_task', { task_id: a.task_id }];
      if (a.action === 'wait') return ['wait_task', { task_id: a.task_id, wait_seconds: a.wait_seconds ?? 45 }];
      if (a.action === 'diff') return ['task_diff', { task_id: a.task_id }];
      if (a.action === 'review') return ['review_task', { task_id: a.task_id, verdict: a.verdict, rating: a.rating, note: a.result }];
      return ['finish_task', { task_id: a.task_id, result: a.result, attachments: a.attachments, status: a.action === 'cancel' ? 'cancelled' : a.action }];
    }),
  );

  tool(
    'update_me',
    'Your state: activity, status, focus, model, avatar, checkpoint (notes to self, returned when you rejoin, e.g. in a fresh chat), usage numbers if your app shows them.',
    {
      activity: z.string().optional(),
      status: z.enum(['online', 'away']).optional(),
      focus: z.enum(['focus', 'all']).optional(),
      model: z.string().optional(),
      avatar: z.string().optional().describe(AVATAR_HINT),
      checkpoint: z.string().optional(),
      context_used_percent: z.number().optional(),
      session_limit_used_percent: z.number().optional(),
      weekly_limit_used_percent: z.number().optional(),
      usage_note: z.string().optional(),
    },
    WRITE,
    act('update_me'),
  );

  tool(
    'memory',
    'Room memory. remember: a short fact, decision, preference or lesson (private = only you). recall: a few words, best matches only. edit / forget: by id. import: text of a memory file (one memory per bullet, # headings = tags) to share what you know.',
    {
      action: z.enum(['remember', 'recall', 'forget', 'edit', 'import']),
      text: z.string().optional(),
      query: z.string().optional(),
      tags: z.array(z.string()).optional(),
      kind: z.enum(['fact', 'decision', 'preference', 'todo', 'lesson']).optional(),
      private: z.boolean().optional(),
      id: z.string().optional(),
      limit: z.number().optional(),
    },
    WRITE,
    act((a) => (a.action === 'recall'
      ? ['recall', { query: a.query ?? a.text, tags: a.tags, limit: a.limit }]
      : a.action === 'forget' ? ['forget', { id: a.id }]
        : a.action === 'edit' ? ['edit_memory', { id: a.id, text: a.text, kind: a.kind, tags: a.tags }]
          : a.action === 'import' ? ['import_memory', { text: a.text, tags: a.tags, kind: a.kind }]
            : ['remember', { text: a.text, tags: a.tags, kind: a.kind, private: a.private }])),
  );
  tool(
    'team_log',
    'The team ledger (kept across chapters): who did what and when. about: a member name, task id or file path; empty = latest.',
    { about: z.string().optional(), limit: z.number().optional() },
    RO,
    act('team_log'),
  );

  tool(
    'toolbox',
    'Commands the team shares by name (lint, test, e2e...). list | add (name, command, description) | run (name; approved tools run without asking the human) | remove.',
    { action: z.enum(['list', 'add', 'run', 'remove']), name: z.string().optional(), command: z.string().optional(), description: z.string().optional(), wait_seconds: z.number().optional() },
    WRITE,
    act('toolbox'),
  );


  tool(
    'lead_action',
    'Lead only. new_chapter (value = summary): archive the chat, everyone continues fresh. summary / brief (value). knowledge (value: files to read first, comma-separated). rank (name, value senior|mid|junior|trainee|auto). pause / resume (name, or everyone). stop (name): pause it, free its files, reopen its tasks. lead (name). focus (name, value focus|all).',
    { action: z.enum(['new_chapter', 'summary', 'knowledge', 'rank', 'pause', 'resume', 'stop', 'lead', 'brief', 'focus']), name: z.string().optional(), value: z.string().optional() },
    WRITE,
    act((a) => {
      if (['pause', 'resume', 'stop'].includes(a.action) && a.name) return ['control_member', { name: a.name, action: a.action, reason: a.value }];
      if (a.action === 'stop') throw new RoomError('stop needs the member name.');
      if (a.action === 'new_chapter') return ['new_chapter', { summary: a.value }];
      if (a.action === 'knowledge') return ['set_knowledge', { files: a.value }];
      if (a.action === 'summary') return ['set_summary', { text: a.value }];
      if (a.action === 'rank') return ['set_rank', { name: a.name, rank: a.value }];
      return {
        brief: ['set_brief', { brief: a.value }],
        lead: ['set_lead', { name: a.name || a.value }],
        pause: ['pause', { paused: true, reason: a.value }],
        resume: ['pause', { paused: false }],
        focus: ['set_focus', { name: a.name, mode: a.value }],
      }[a.action];
    }),
  );

  // ---------------- project files ----------------

  tool('list_files', 'List project files.', { dir: z.string().optional(), depth: z.number().optional() }, RO, act('list_files'));

  tool('read_file', 'Read a project file (images are returned as images).', { path: z.string(), start_line: z.number().optional(), end_line: z.number().optional() }, RO, async (args) => {
    const ext = path.extname(String(args.path || '')).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return act('read_file')(args);
    try {
      const { room } = who();
      const { abs, rel } = room.safePath(args.path);
      if (!fs.existsSync(abs)) throw new RoomError(`${rel} does not exist.`, 404);
      const data = fs.readFileSync(abs);
      if (data.length > 8 * 1024 * 1024) throw new RoomError('Image is too large to view (max 8 MB).');
      return { content: [{ type: 'image', data: data.toString('base64'), mimeType: ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}` }, { type: 'text', text: `${rel} (${data.length} bytes)` }] };
    } catch (err) {
      return fail(err);
    }
  });

  tool('search_files', 'Search text in project files.', { query: z.string(), dir: z.string().optional(), max_results: z.number().optional() }, RO, act('search_files'));
  tool('project_changes', 'Git status, diff and recent commits (review others\' work).', { path: z.string().optional() }, RO, act('project_changes'));
  tool('claim_file', 'Claim a file before editing so nobody else edits it; release: true when done.', { path: z.string(), note: z.string().optional(), release: z.boolean().optional() }, WRITE,
    act((a) => (a.release ? ['release_file', { path: a.path }] : ['claim_file', { path: a.path, note: a.note }])));
  tool('write_file', 'Create or overwrite a project file (old version kept). Claim it first.', { path: z.string(), content: z.string() }, DESTRUCTIVE, act('write_file'));
  tool('edit_file', 'Replace exact text in a file (old_text must match once unless replace_all).', { path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional() }, DESTRUCTIVE, act('edit_file'));
  tool('restore_file', 'Undo: restore an earlier version of a file edited through the room (list: true shows versions).', { path: z.string(), version: z.string().optional(), list: z.boolean().optional() }, DESTRUCTIVE,
    act((a) => (a.list ? ['file_history', { path: a.path }] : ['restore_file', { path: a.path, version: a.version }])));

  // ---------------- sharing ----------------

  tool(
    'share_file',
    'Share a file: a generated image (ChatGPT: pass it as "file"), a URL, a project path, base64 or text. Returns an id for get_asset / save_asset.',
    {
      file: z.any().optional().describe('A file from your conversation/sandbox, e.g. a generated image.'),
      url: z.string().optional(),
      path: z.string().optional(),
      base64: z.string().optional(),
      text: z.string().optional(),
      name: z.string().optional(),
      mime: z.string().optional(),
      message: z.string().optional(),
      to: z.string().optional(),
    },
    WRITE,
    async (args = {}) => {
      try {
        const { room, member } = who();
        const { file, ...rest } = args;
        if (file) {
          // ChatGPT turns a declared file param into { download_url, file_id, mime_type, file_name }.
          const f = typeof file === 'string' ? { download_url: /^https?:/i.test(file) ? file : null, path: file } : file;
          const urlOf = f.download_url || f.url || f.downloadUrl;
          if (!urlOf) {
            throw new RoomError(`Your app passed only a reference (${f.path || f.file_id || 'unknown'}) and no download link, so the file cannot be fetched. Ask the human to drag the file onto the Crewroom dashboard (or save it into the project folder) instead.`);
          }
          rest.url = urlOf;
          rest.name ||= f.file_name || f.name;
          rest.mime ||= f.mime_type || f.mimeType;
        }
        const out = text(await room.call('share_file', member, rest));
        room.account(member, JSON.stringify(rest).length, out.content[0].text.length);
        return out;
      } catch (err) {
        return fail(err);
      }
    },
    { 'openai/fileParams': ['file'] },
  );

  tool('get_asset', 'Open a shared file (images come back as images).', { asset_id: z.string() }, RO, async (args) => {
    try {
      const { room } = who();
      const a = room.assetFile(args.asset_id);
      if (!a || !fs.existsSync(a.file)) throw new RoomError(`No shared file with id ${args.asset_id}.`, 404);
      const data = fs.readFileSync(a.file);
      const caption = { type: 'text', text: `${a.name} (${a.mime}, ${a.size} bytes) shared by ${room._nameOf(a.from)}${a.projectPath ? `, saved at ${a.projectPath}` : ''}` };
      if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime) && data.length <= 8 * 1024 * 1024) {
        return { content: [{ type: 'image', data: data.toString('base64'), mimeType: a.mime }, caption] };
      }
      if (a.mime.startsWith('text/') || /json|svg|xml|javascript/.test(a.mime)) {
        return { content: [caption, { type: 'text', text: data.toString('utf8').slice(0, 200_000) }] };
      }
      return { content: [caption, { type: 'text', text: 'Binary file. Save it into the project with save_asset to use it.' }] };
    } catch (err) {
      return fail(err);
    }
  });

  tool('save_asset', 'Save a shared file into the project (e.g. public/icon.png).', { asset_id: z.string(), path: z.string() }, WRITE, act('save_asset'));

  tool(
    'run_command',
    'Run a shell command in the project on the human\'s computer (they may need to approve). Only if you have no terminal. command_id: get a result later.',
    { command: z.string().optional(), command_id: z.string().optional(), timeout_seconds: z.number().optional(), wait_seconds: z.number().optional() },
    DESTRUCTIVE,
    act((a) => (a.command_id ? ['command_result', { command_id: a.command_id, wait_seconds: a.wait_seconds }] : ['run_command', a])),
  );

  return server;
}
