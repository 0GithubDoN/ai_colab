// MCP tools for the room. Used by every MCP-capable app: through the local
// stdio bridge (Claude desktop, Codex, Antigravity, Cursor, VS Code, Gemini
// CLI...) or over HTTP (ChatGPT / Claude.ai connectors through a public link).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { RoomError, RULES } from './room.js';
import { normalizeCode, VERSION, IMAGE_EXTS } from './util.js';

const token = z.string().optional().describe('Your member token from join_room. Only needed if the app lost its connection and you get a "not joined" error.');
const RO = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/**
 * ctx: { hub, roomCode?: string (fixed room for /r/<code>/mcp), local: boolean, token?: string }
 */
export function createMcpServer(ctx) {
  const { hub } = ctx;
  const server = new McpServer(
    { name: 'crewroom', version: VERSION },
    {
      instructions: [
        'Crewroom connects you to a team room where several AI assistants from different apps work on one project together, while their human watches on a live dashboard.',
        'When the user gives you a Crewroom invite link or code (looks like ABCD-EFGH-JKLM), call join_room with it, your name and your capabilities.',
        'Then work in a loop: wait_for_updates -> act with your own tools -> report -> wait_for_updates.',
        ...RULES,
      ].join('\n'),
    },
  );

  const who = (args) => {
    const tok = args?.token || ctx.token;
    const found = tok && hub.findMember(tok);
    if (!found) throw new RoomError('You have not joined a room yet (or the hub restarted). Call join_room with the invite code, or pass your token.', 401);
    ctx.token = tok;
    return found;
  };

  const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
  const fail = (err) => ({ isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] });

  /** Wrap a room action as a tool handler. */
  const act = (action, mapArgs = (a) => a) => async (args = {}) => {
    try {
      const { room, member } = who(args);
      const { token: _t, ...rest } = args;
      return text(await room.call(action, member, mapArgs(rest)));
    } catch (err) {
      return fail(err);
    }
  };

  const tool = (name, description, shape, annotations, handler, meta) =>
    server.registerTool(name, { description, inputSchema: shape, annotations, ...(meta ? { _meta: meta } : {}) }, handler);

  // ---------------- joining ----------------

  tool(
    'join_room',
    'Join a Crewroom team room. Call this when the user gives you an invite link or code. Use a short name others can @mention (e.g. "ChatGPT", "Gemini", "Claude", "Codex") and list what you can do that others may not. Returns your token, the lead, the brief and the house rules.',
    {
      invite: z.string().optional().describe('The invite link or room code the user gave you (e.g. "http://127.0.0.1:7777/r/ABCD-EFGH-JKLM/join" or "ABCD-EFGH-JKLM").'),
      name: z.string().describe('Your display name in the room.'),
      app: z.string().optional().describe('The app you run in, e.g. "ChatGPT desktop", "Claude desktop", "Antigravity", "Codex".'),
      model: z.string().optional().describe('Your model, if you know it.'),
      capabilities: z.array(z.string()).optional().describe('What you can do, e.g. ["image-generation","web-search","code-execution","terminal","local-files","browser","long-context"].'),
      lead: z.boolean().optional().describe('Ask to be the lead (only works if the room has no lead yet).'),
      token: z.string().optional().describe('Your previous token, to come back as the same member.'),
    },
    WRITE,
    async (args) => {
      try {
        let room = null;
        if (args.token) room = hub.findMember(args.token)?.room || null;
        if (!room && ctx.roomCode) room = hub.room(ctx.roomCode);
        if (!room && args.invite) {
          const code = normalizeCode(args.invite);
          if (!code) throw new RoomError('That does not look like a Crewroom invite code. It looks like ABCD-EFGH-JKLM or a link containing /r/ABCD-EFGH-JKLM.');
          room = hub.room(code);
          if (!room) throw new RoomError('No room with that code is open on this computer. Ask the human to run "crewroom start" in the project folder (or check the code).', 404);
        }
        if (!room) {
          const open = hub.listRooms();
          if (ctx.local && open.length === 1) room = open[0];
          else if (!open.length) throw new RoomError('No room is open. Ask the human to run "crewroom start" in their project folder, then give you the invite link.', 404);
          else throw new RoomError('Which room? Ask the human for the invite link or code and pass it as "invite".');
        }
        const result = await room.call('join', null, { ...args, via: ctx.local ? 'mcp (local)' : 'mcp (public link)' });
        ctx.token = result.your_token;
        return text(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------------- conversation ----------------

  tool(
    'wait_for_updates',
    'Get new messages and tasks for you. If nothing is new it waits up to timeout_seconds for something to arrive. Call this in a loop to stay in the team conversation, and follow the "guidance" field.',
    {
      timeout_seconds: z.number().optional().describe('How long to wait for news. Default 40. Keep it under ~50 unless your app allows long tool calls.'),
      include_history: z.number().optional().describe('Also return this many earlier messages for context (useful right after joining).'),
      token,
    },
    RO,
    act('wait', (a) => ({ timeout_seconds: 40, ...a })),
  );

  tool('room_status', 'Who is in the room and what they are doing, open tasks, files being edited, decisions, the project brief.', { token }, RO, act('status'));

  tool(
    'send_message',
    'Post a message. Leave "to" empty to talk to everyone, or give a member name, "lead" or "human" for a direct message. Use @Name in the text to get someone\'s attention.',
    { text: z.string(), to: z.string().optional(), attachments: z.array(z.string()).optional().describe('Ids of shared files (from share_file) to attach.'), token },
    WRITE,
    act('send'),
  );

  tool('read_messages', 'Read earlier messages (history).', { limit: z.number().optional(), before_seq: z.number().optional(), token }, RO, act('read_messages'));

  tool(
    'set_activity',
    'Tell the team what you are doing (shown on the dashboard). Set status "away" before you stop (e.g. out of usage, chat closing) and "online" when you are back.',
    { activity: z.string().optional(), status: z.enum(['online', 'away']).optional(), token },
    WRITE,
    act('set_activity'),
  );

  // ---------------- tasks ----------------

  tool(
    'ask_member',
    'Ask a teammate to do something and get the result back: generate an image, review or fix a file, research, run something, give an opinion. Leave "to" empty to post an open task anyone can take.',
    {
      title: z.string().describe('Short summary of what you need.'),
      details: z.string().optional().describe('Full instructions, context and what "done" looks like.'),
      to: z.string().optional().describe('Member name or "lead". Empty = anyone.'),
      kind: z.enum(['task', 'review', 'fix', 'question', 'asset', 'research']).optional(),
      files: z.array(z.string()).optional().describe('Project files this is about.'),
      token,
    },
    WRITE,
    act('ask'),
  );

  tool('take_task', 'Start working on a task (an open one, or one assigned to you), so others know.', { task_id: z.string(), token }, WRITE, act('take_task'));

  tool(
    'finish_task',
    'Report a task result. It goes back to whoever asked. Use status "blocked" if you cannot do it, and say why.',
    {
      task_id: z.string(),
      result: z.string().describe('What you did, found or decided.'),
      status: z.enum(['done', 'blocked', 'cancelled']).optional(),
      attachments: z.array(z.string()).optional().describe('Ids of shared files, e.g. an image you shared with share_file.'),
      token,
    },
    WRITE,
    act('finish_task'),
  );

  tool('list_tasks', 'List tasks in the room.', { include_done: z.boolean().optional(), token }, RO, act('list_tasks'));

  // ---------------- memory ----------------

  tool('add_note', 'Save a note or a decision to the shared project memory every AI can read.', { text: z.string(), kind: z.enum(['note', 'decision']).optional(), token }, WRITE, act('note'));
  tool('read_notes', 'Read shared notes and decisions.', { kind: z.enum(['note', 'decision']).optional(), token }, RO, act('notes'));

  // ---------------- project files ----------------

  tool('list_files', 'List files in the project folder.', { dir: z.string().optional(), depth: z.number().optional(), token }, RO, act('list_files'));
  tool('read_file', 'Read a text file from the project.', { path: z.string(), start_line: z.number().optional(), end_line: z.number().optional(), token }, RO, act('read_file'));
  tool('search_files', 'Search text in project files.', { query: z.string(), dir: z.string().optional(), max_results: z.number().optional(), token }, RO, act('search_files'));
  tool('project_changes', 'See what changed in the project (git status, diff, recent commits). Great for reviewing others\' work.', { path: z.string().optional().describe('Limit to one file.'), token }, RO, act('project_changes'));
  tool('claim_file', 'Claim a file before editing it, so nobody else edits it at the same time.', { path: z.string(), note: z.string().optional(), token }, WRITE, act('claim_file'));
  tool('release_file', 'Release a file you claimed.', { path: z.string(), token }, WRITE, act('release_file'));
  tool('write_file', 'Create or overwrite a project file. The previous version is kept (restore_file can undo). Claim the file first.', { path: z.string(), content: z.string(), token }, DESTRUCTIVE, act('write_file'));
  tool(
    'edit_file',
    'Replace exact text in a project file. old_text must appear exactly once (copy it from read_file), unless replace_all is true.',
    { path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional(), token },
    DESTRUCTIVE,
    act('edit_file'),
  );
  tool('file_history', 'List saved earlier versions of a file (from edits made through the room).', { path: z.string(), token }, RO, act('file_history'));
  tool('restore_file', 'Restore a file to an earlier version (latest saved version if none given).', { path: z.string(), version: z.string().optional(), token }, DESTRUCTIVE, act('restore_file'));

  tool('view_image', 'Look at an image file from the project (png, jpg, gif, webp).', { path: z.string(), token }, RO, async (args) => {
    try {
      const { room } = who(args);
      const { abs, rel } = room.safePath(args.path);
      const ext = path.extname(rel).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) throw new RoomError('view_image supports png, jpg, gif and webp. Use read_file for text (svg is text).');
      if (!fs.existsSync(abs)) throw new RoomError(`${rel} does not exist.`, 404);
      const data = fs.readFileSync(abs);
      if (data.length > 8 * 1024 * 1024) throw new RoomError('Image is too large to view (max 8 MB).');
      const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
      return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime }, { type: 'text', text: `${rel} (${data.length} bytes)` }] };
    } catch (err) {
      return fail(err);
    }
  });

  // ---------------- sharing files & images ----------------

  tool(
    'share_file',
    [
      'Share a file with the team: an image you generated, a document, a project file. Pass ONE of: file, url, path, base64, text.',
      'ChatGPT: after generating an image, pass it as "file" (its /mnt/data/... path) and it is uploaded automatically.',
      'Returns an id others can open with get_asset or save into the project with save_asset. Posts a message unless message is false.',
    ].join(' '),
    {
      file: z.any().optional().describe('A file from your own conversation/sandbox, e.g. an image you generated or a file the user uploaded to you.'),
      url: z.string().optional().describe('Public http(s) URL of a file to fetch (e.g. a hosted image you created).'),
      path: z.string().optional().describe('A file inside the project folder.'),
      base64: z.string().optional().describe('Base64 or data: URL of file contents.'),
      text: z.string().optional().describe('Plain text content (e.g. an SVG, a document).'),
      name: z.string().optional().describe('File name, e.g. "icon.png".'),
      mime: z.string().optional(),
      message: z.string().optional().describe('Message to post with it.'),
      to: z.string().optional().describe('Send to one member instead of everyone.'),
      token,
    },
    WRITE,
    async (args = {}) => {
      try {
        const { room, member } = who(args);
        const { token: _t, file, ...rest } = args;
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
        return text(await room.call('share_file', member, rest));
      } catch (err) {
        return fail(err);
      }
    },
    { 'openai/fileParams': ['file'] },
  );

  tool('get_asset', 'Open a shared file. Images come back as images you can see; text files as text.', { asset_id: z.string(), token }, RO, async (args) => {
    try {
      const { room } = who(args);
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

  tool('save_asset', 'Save a shared file into the project, e.g. put a generated icon at public/icon.png.', { asset_id: z.string(), path: z.string(), token }, WRITE, act('save_asset'));
  tool('list_assets', 'List files and images shared in the room.', { token }, RO, act('list_assets'));

  // ---------------- commands ----------------

  tool(
    'run_command',
    'Run a shell command in the project folder on the human\'s computer (e.g. "npm test"). Depending on room settings the human approves it first. Use this only if you have no terminal of your own.',
    {
      command: z.string(),
      timeout_seconds: z.number().optional().describe('Kill the command after this long. Default 120.'),
      wait_seconds: z.number().optional().describe('How long to wait for approval/result before returning. Default 45; then use command_result.'),
      token,
    },
    DESTRUCTIVE,
    act('run_command'),
  );
  tool('command_result', 'Get the result of a command you asked to run.', { command_id: z.string(), wait_seconds: z.number().optional(), token }, RO, act('command_result'));

  // ---------------- lead ----------------

  tool('set_brief', 'Lead: set the project brief every member sees when joining.', { brief: z.string(), token }, WRITE, act('set_brief'));
  tool('set_lead', 'Lead: hand leadership to another member.', { name: z.string(), token }, WRITE, act('set_lead'));
  tool('pause_room', 'Lead: pause or resume the whole team.', { paused: z.boolean(), reason: z.string().optional(), token }, WRITE, act('pause'));

  return server;
}
