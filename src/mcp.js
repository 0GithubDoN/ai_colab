// MCP server exposing the room as tools, for apps that connect through MCP
// (ChatGPT connectors, Claude connectors, Antigravity, Codex, Cursor, Gemini CLI...).
// One McpServer per MCP session; the session remembers who joined.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import { RoomError, RULES } from './room.js';

const token = z.string().optional().describe('Your member token from join_room. Only needed if the app lost the session.');

export function createMcpServer(room, ctx) {
  const server = new McpServer(
    { name: 'airoom', version: '0.1.0' },
    {
      instructions: [
        `This is an AI team room for the project "${room.s.name}". Several AI assistants from different apps are working on it together, and a human watches on a live dashboard.`,
        'Start by calling join_room with your name and the app you run in. Then work in a loop: wait_for_updates -> act -> report -> wait_for_updates.',
        ...RULES,
      ].join('\n'),
    },
  );

  const actor = (args) => {
    const m = (args?.token && room.memberByToken(args.token)) || (ctx.memberId && room.s.members[ctx.memberId]);
    if (!m) throw new RoomError('You have not joined yet. Call join_room first.', 401);
    ctx.memberId = m.id;
    return m;
  };

  const run = (action, needsActor = true) => async (args) => {
    try {
      const { token: _t, ...rest } = args || {};
      const result = await room.call(action, needsActor ? actor(args) : null, rest);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  };

  const tool = (name, description, shape, handler) => server.registerTool(name, { description, inputSchema: shape }, handler);

  tool(
    'join_room',
    'Join the team room. Call this first. Use a short name others will @mention you by (e.g. "ChatGPT", "Gemini"). List what you can do that others may not (e.g. image-generation, web-search, code-execution, local-files). Returns your token, the lead, the brief and the rules.',
    {
      name: z.string().describe('Your display name in the room.'),
      app: z.string().optional().describe('The app you are running in, e.g. "ChatGPT desktop", "Antigravity".'),
      model: z.string().optional().describe('Your model, if you know it.'),
      capabilities: z.array(z.string()).optional().describe('Things you can do, e.g. ["image-generation","web-search","code-execution","local-files","terminal"].'),
      lead: z.boolean().optional().describe('Ask to be the lead (only works if there is no lead yet).'),
      token: z.string().optional().describe('Pass your old token to resume as the same member.'),
    },
    async (args) => {
      try {
        const result = await room.call('join', null, { ...args, access: 'remote' });
        const m = room.memberByToken(result.your_token);
        ctx.memberId = m.id;
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  tool(
    'wait_for_updates',
    'Get new messages and tasks for you. If nothing is new it waits up to timeout_seconds for something to arrive. Call this in a loop to stay in the conversation. Follow the "guidance" field in the result.',
    {
      timeout_seconds: z.number().optional().describe('How long to wait for news (0-600). Default 45. Use a lower value if your app times out tool calls.'),
      include_history: z.number().optional().describe('Also return this many earlier messages for context.'),
      token,
    },
    async (args) => run('wait')({ timeout_seconds: 45, ...args }),
  );

  tool('room_status', 'Who is in the room, what everyone is doing, open tasks, file claims, decisions and the project brief.', { token }, run('status'));

  tool(
    'send_message',
    'Post a message to the room. Leave "to" empty to talk to everyone, or name a member (or "lead", or "human") for a direct message.',
    {
      text: z.string(),
      to: z.string().optional().describe('Member name, "lead", "human", or empty for everyone.'),
      attachments: z.array(z.string()).optional().describe('Asset ids to attach (from share_file).'),
      token,
    },
    run('send'),
  );

  tool(
    'ask_member',
    'Ask a teammate to do something and get the result back: fix a file, review code, generate an image, research, give an opinion. Leave "to" empty to post an open task anyone can take.',
    {
      title: z.string().describe('Short summary of what you need.'),
      details: z.string().optional().describe('Full instructions, context, acceptance criteria.'),
      to: z.string().optional().describe('Member name or "lead". Empty = anyone.'),
      kind: z.enum(['task', 'review', 'question', 'asset', 'research']).optional(),
      files: z.array(z.string()).optional().describe('Project files this is about.'),
      token,
    },
    run('ask'),
  );

  tool('take_task', 'Take an open task so others know you are on it.', { task_id: z.string(), token }, run('take_task'));

  tool(
    'finish_task',
    'Report the result of a task. The result goes back to whoever asked. Use status "blocked" if you cannot do it and explain why.',
    {
      task_id: z.string(),
      result: z.string().describe('What you did / found / your answer.'),
      status: z.enum(['done', 'blocked', 'cancelled']).optional(),
      attachments: z.array(z.string()).optional().describe('Asset ids, e.g. a generated image you shared with share_file.'),
      token,
    },
    run('finish_task'),
  );

  tool('list_tasks', 'List tasks in the room.', { include_done: z.boolean().optional(), token }, run('list_tasks'));

  tool(
    'set_activity',
    'Tell the team what you are doing right now (shown on the dashboard). Set status "away" before you stop working (e.g. running out of usage), and "online" when back.',
    { activity: z.string().optional(), status: z.enum(['online', 'away']).optional(), token },
    run('set_activity'),
  );

  tool('claim_file', 'Claim a project file before editing it, so nobody else edits it at the same time.', { path: z.string(), note: z.string().optional(), token }, run('claim_file'));
  tool('release_file', 'Release a file you claimed.', { path: z.string(), token }, run('release_file'));

  tool('add_note', 'Save a note or a decision to the shared project memory that every AI can read later.', { text: z.string(), kind: z.enum(['note', 'decision']).optional(), token }, run('note'));
  tool('read_notes', 'Read the shared project notes and decisions.', { kind: z.enum(['note', 'decision']).optional(), token }, run('notes'));
  tool('read_messages', 'Read earlier room messages (history).', { limit: z.number().optional(), before_seq: z.number().optional(), token }, run('read_messages'));

  tool('list_files', 'List files in the shared project.', { dir: z.string().optional(), depth: z.number().optional(), token }, run('list_files'));
  tool('read_file', 'Read a project file.', { path: z.string(), start_line: z.number().optional(), end_line: z.number().optional(), token }, run('read_file'));
  tool('search_files', 'Search text across project files.', { query: z.string(), dir: z.string().optional(), max_results: z.number().optional(), token }, run('search_files'));
  tool('write_file', 'Create or overwrite a project file (the old version is backed up). Claim the file first.', { path: z.string(), content: z.string(), token }, run('write_file'));
  tool(
    'edit_file',
    'Replace exact text in a project file. old_text must match exactly once unless replace_all is set.',
    { path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional(), token },
    run('edit_file'),
  );

  tool(
    'share_file',
    'Share something with the team as an asset: a project file (path), raw base64 data (e.g. an image you created), or text. Optionally posts a message with it.',
    {
      path: z.string().optional().describe('Project file to share.'),
      base64: z.string().optional().describe('Base64 or data: URL of a file you made.'),
      text: z.string().optional().describe('Text content to share as a file.'),
      name: z.string().optional().describe('File name, e.g. icon.png'),
      mime: z.string().optional(),
      message: z.string().optional().describe('Message to post with it.'),
      to: z.string().optional(),
      token,
    },
    run('share_file'),
  );

  tool('save_asset', 'Save a shared asset into the project folder at the given path (e.g. put a generated icon into public/icon.png).', { asset_id: z.string(), path: z.string(), token }, run('save_asset'));
  tool('list_assets', 'List images and files shared in the room.', { token }, run('list_assets'));

  tool('get_asset', 'Open a shared asset. Images are returned as images you can look at; text files as text.', { asset_id: z.string(), token }, async (args) => {
    try {
      actor(args);
      const a = room.assetFile(args.asset_id);
      if (!a) throw new RoomError(`No asset ${args.asset_id}.`, 404);
      const data = fs.readFileSync(a.file);
      if (a.mime.startsWith('image/') && a.mime !== 'image/svg+xml') {
        return { content: [{ type: 'image', data: data.toString('base64'), mimeType: a.mime }, { type: 'text', text: `${a.name} (${a.size} bytes) from ${room._nameOf(a.from)}` }] };
      }
      if (a.mime.startsWith('text/') || a.mime === 'application/json' || a.mime === 'image/svg+xml') {
        return { content: [{ type: 'text', text: data.toString('utf8').slice(0, 200_000) }] };
      }
      return { content: [{ type: 'text', text: `${a.name} is a ${a.mime} file of ${a.size} bytes. Download: ${a.id}` }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  // Lead / coordination tools
  tool('set_brief', 'Lead only: set the project brief every member sees when joining.', { brief: z.string(), token }, run('set_brief'));
  tool('set_lead', 'Lead only: hand leadership to another member.', { name: z.string(), token }, run('set_lead'));
  tool('pause_room', 'Lead only: pause or resume the whole team.', { paused: z.boolean(), reason: z.string().optional(), token }, run('pause'));

  return server;
}
