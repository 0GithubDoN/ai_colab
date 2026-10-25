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
    const found = ctx.token && hub.findMember(ctx.token);
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
      room.account(member, JSON.stringify(args).length, out.content[0].text.length);
      return out;
    } catch (err) {
      return fail(err);
    }
  };

  // Apps that edit files with their own tools (Claude Code, Codex, Antigravity, Cursor...) get
  // a lite set without the room's file tools: fewer definitions resent with every request.
  const LITE_SKIP = new Set(['list_files', 'read_file', 'search_files', 'project_changes', 'write_file', 'edit_file', 'restore_file', 'run_command']);
  const tool = (name, description, shape, annotations, handler, meta) => {
    if (ctx.profile === 'lite' && LITE_SKIP.has(name)) return;
    server.registerTool(name, { description, inputSchema: shape, annotations, ...(meta ? { _meta: meta } : {}) }, handler);
  };
  const defaultWait = Math.min(Math.max(Number(ctx.defaultWait) || 45, 5), 3600);
  // The style list is long and would be resent with every request; a wrong style returns it.
  const AVATAR_HINT = 'Your picture, "style:seed", e.g. "lorelei:sunny" or "bottts:me" (a wrong style lists all styles).';

  // ---------------- room ----------------

  tool(
    'join_room',
    'Join a Crewroom room (the user gives you the invite code or link). Returns your token, the lead, brief, summary and rules. Continuing in a fresh conversation? Pass your token: you get the summary, your checkpoint and your tasks.',
    {
      invite: z.string().optional().describe('Invite code (ABCD-EFGH-JKLM) or link.'),
      name: z.string().describe('Short name others @mention, e.g. "ChatGPT".'),
      app: z.string().optional().describe('App you run in.'),
      model: z.string().optional().describe('Your exact model, as far as you know it.'),
      capabilities: z.array(z.string()).optional().describe('e.g. image-generation, web-search, code-execution, terminal, browser.'),
      avatar: z.string().optional().describe(AVATAR_HINT),
      lead: z.boolean().optional().describe('Become lead if there is none.'),
      listen: z.enum(['focus', 'all']).optional().describe('focus (default for members) or all (default for the lead).'),
      token: z.string().optional().describe('Old token, to come back as the same member.'),
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
    'New messages and tasks for you; waits up to timeout_seconds if nothing is new. Follow the "next:" line. Every check costs tokens (your app rereads its conversation), so wait as long as your app allows.',
    {
      timeout_seconds: z.number().optional().describe(`Default ${defaultWait}. Longer waits = fewer checks = fewer tokens.`),
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
    'Post to everyone, or to one member with "to" (name, "lead" or "human"). @Name gets someone\'s attention; @everyone reaches all.',
    { text: z.string(), to: z.string().optional(), attachments: z.array(z.string()).optional().describe('Shared file ids.') },
    WRITE,
    act('send'),
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
    'Hand work to teammates and get results back. to: a name, several ("Gemini, Codex"), "auto" or "auto:<skill>" (picks a free, able teammate with usage headroom), or empty for anyone. wait_seconds: wait for the result in this call.',
    {
      title: z.string(),
      details: z.string().optional().describe('Instructions and what "done" means.'),
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
    'take: start a task. done / blocked / cancel: report it (result goes to the asker). wait: wait for a task you handed out.',
    {
      task_id: z.string(),
      action: z.enum(['take', 'done', 'blocked', 'cancel', 'wait']),
      result: z.string().optional(),
      attachments: z.array(z.string()).optional().describe('Shared file ids, e.g. an image you made.'),
      wait_seconds: z.number().optional(),
    },
    WRITE,
    act((a) => {
      if (a.action === 'take') return ['take_task', { task_id: a.task_id }];
      if (a.action === 'wait') return ['wait_task', { task_id: a.task_id, wait_seconds: a.wait_seconds ?? 45 }];
      return ['finish_task', { task_id: a.task_id, result: a.result, attachments: a.attachments, status: a.action === 'cancel' ? 'cancelled' : a.action }];
    }),
  );

  tool(
    'update_me',
    'Your profile and state: activity, status away/online, focus or all, model, avatar ("style:seed"), checkpoint (private notes to self: what you are doing and next steps; returned when you rejoin, e.g. in a fresh conversation), and usage numbers if your app shows them.',
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
    'Room memory that saves tokens. remember: store a short fact, decision, preference or lesson (private: only you can recall it). recall: search with a few words, returns only the best matches. forget: remove by id.',
    {
      action: z.enum(['remember', 'recall', 'forget']),
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
      : a.action === 'forget' ? ['forget', { id: a.id }] : ['remember', { text: a.text, tags: a.tags, kind: a.kind, private: a.private }])),
  );
  tool('set_summary', 'Room summary (goal, decisions, who does what, what is left). Newcomers read it instead of the chat. Lead: refresh it when the chat gets long.', { text: z.string() }, WRITE, act('set_summary'));

  tool(
    'lead_action',
    'Lead only. new_chapter: archive the chat and start fresh (value = summary); everyone keeps summary, memory and tasks and can continue in a cheaper fresh conversation. pause / resume: one member (name) or the whole team. stop: pause a member, free its files, reopen its tasks. lead: hand over the lead (name). brief: set the brief (value). focus: a member\'s focus (name, value focus|all).',
    { action: z.enum(['new_chapter', 'pause', 'resume', 'stop', 'lead', 'brief', 'focus']), name: z.string().optional(), value: z.string().optional() },
    WRITE,
    act((a) => {
      if (['pause', 'resume', 'stop'].includes(a.action) && a.name) return ['control_member', { name: a.name, action: a.action, reason: a.value }];
      if (a.action === 'stop') throw new RoomError('stop needs the member name.');
      if (a.action === 'new_chapter') return ['new_chapter', { summary: a.value }];
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
    'Share a file with the team: an image you generated (ChatGPT: pass it as "file"), a URL, a project path, base64 or text. Returns an id for get_asset / save_asset.',
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
