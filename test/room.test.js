import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';
import { Room, HUMAN_ID } from '../src/room.js';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'airoom.js');
const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airoom-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("hello");\n');
  return dir;
};

test('core: join, lead, ask, finish, and the result goes back to the asker', async () => {
  const room = new Room({ projectRoot: tmpProject() });
  const claude = room.memberByToken((await room.call('join', null, { name: 'Claude', app: 'Claude desktop', lead: true })).your_token);
  const gpt = room.memberByToken((await room.call('join', null, { name: 'ChatGPT', app: 'ChatGPT', capabilities: ['image-generation'] })).your_token);
  assert.equal(room.s.leadId, claude.id);

  const { task } = await room.call('ask', claude, { to: 'ChatGPT', title: 'Make an icon', kind: 'asset' });
  const forGpt = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.equal(forGpt.your_tasks[0].id, task.id);
  assert.ok(forGpt.new_messages.some((m) => m.task_id === task.id));

  const shared = await room.call('share_file', gpt, { base64: Buffer.from('PNGDATA').toString('base64'), name: 'icon.png', message: false });
  await room.call('finish_task', gpt, { task_id: task.id, result: 'Here it is', attachments: [shared.asset.id] });
  const forClaude = await room.call('wait', claude, { timeout_seconds: 0 });
  const result = forClaude.new_messages.find((m) => m.kind === 'result');
  assert.equal(result.from, 'ChatGPT');
  assert.equal(result.to, 'Claude');
  assert.equal(result.attachments[0].name, 'icon.png');

  await room.call('save_asset', claude, { asset_id: shared.asset.id, path: 'public/icon.png' });
  assert.equal(fs.readFileSync(path.join(room.projectRoot, 'public/icon.png'), 'utf8'), 'PNGDATA');
  room.flush();
});

test('core: wait blocks until a message arrives', async () => {
  const room = new Room({ projectRoot: tmpProject() });
  const a = room.memberByToken((await room.call('join', null, { name: 'A' })).your_token);
  const b = room.memberByToken((await room.call('join', null, { name: 'B' })).your_token);
  await room.call('wait', b, { timeout_seconds: 0 }); // drain join notices
  const started = Date.now();
  const pending = room.call('wait', b, { timeout_seconds: 5 });
  setTimeout(() => room.call('send', a, { text: 'ping' }), 100);
  const r = await pending;
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.new_messages.at(-1).text, 'ping');
  room.flush();
});

test('core: file claims protect files and paths stay inside the project', async () => {
  const room = new Room({ projectRoot: tmpProject() });
  const a = room.memberByToken((await room.call('join', null, { name: 'A' })).your_token);
  const b = room.memberByToken((await room.call('join', null, { name: 'B' })).your_token);
  await room.call('claim_file', a, { path: 'index.js' });
  await assert.rejects(room.call('edit_file', b, { path: 'index.js', old_text: 'hello', new_text: 'hi' }), /claimed by A/);
  await room.call('edit_file', a, { path: 'index.js', old_text: 'hello', new_text: 'hi' });
  assert.match(fs.readFileSync(path.join(room.projectRoot, 'index.js'), 'utf8'), /hi/);
  await assert.rejects(room.call('read_file', a, { path: '../../etc/passwd' }), /outside the project/);
  await assert.rejects(room.call('write_file', a, { path: '.airoom/room.json', content: '{}' }), /managed by the room/);
  room.flush();
});

test('core: when the lead is away members are told to finish and wait', async () => {
  const room = new Room({ projectRoot: tmpProject() });
  const lead = room.memberByToken((await room.call('join', null, { name: 'Claude', lead: true })).your_token);
  const g = room.memberByToken((await room.call('join', null, { name: 'Gemini' })).your_token);
  await room.call('ask', lead, { to: 'Gemini', title: 'Write tests' });
  await room.call('set_activity', lead, { status: 'away', activity: 'out of tokens' });
  const r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.equal(r.lead.status, 'away');
  assert.match(r.guidance, /lead \(Claude\) is away. Finish your 1 task/);
  await assert.rejects(room.call('set_brief', g, { brief: 'x' }), /Only the lead/);
  await room.call('set_lead', { id: HUMAN_ID }, { name: 'Gemini' });
  assert.equal(room.leadStatus().name, 'Gemini');
  room.flush();
});

let srv;
let projectDir;
before(async () => {
  projectDir = tmpProject();
  srv = await startServer({ projectRoot: projectDir, port: 0, quiet: true, cliPath: CLI });
});
after(async () => { await srv.close(); });

test('http: invite page, CLI join/say/wait, admin actions', async () => {
  const base = `${srv.localBase}/r/${srv.room.code}`;
  const invite = await (await fetch(`${base}/join`)).text();
  assert.match(invite, /AI TEAM ROOM INVITE/);
  assert.match(invite, /\/mcp/);

  const cli = (...args) => run(process.execPath, [CLI, ...args], { cwd: projectDir });
  const j = await cli('join', '--name', 'Claude', '--app', 'Claude desktop', '--lead');
  assert.match(j.stdout, /Role: lead/);
  await cli('join', '--name', 'Codex', '--app', 'Codex app', '--caps', 'terminal,code-execution');
  await cli('wait', '--as', 'Codex', '--timeout', '0');
  await cli('say', '--as', 'Claude', '--to', 'Codex', 'please review index.js');
  const w = await cli('wait', '--as', 'Codex', '--timeout', '2');
  assert.match(w.stdout, /Claude -> Codex: please review index.js/);

  const res = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': srv.room.adminKey }, body: JSON.stringify({ text: 'hello from the human' }) });
  assert.equal(res.status, 200);
  const bad = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' });
  assert.equal(bad.status, 401);
  assert.equal((await fetch(`${srv.localBase}/r/WRONG/join`)).status, 404);
  assert.equal((await fetch(`${base}/dashboard`)).status, 403);
  assert.equal((await fetch(`${base}/dashboard?key=${srv.room.adminKey}`)).status, 200);
});

test('mcp: a connector-style client joins, chats, edits files and sees images', async () => {
  const client = new Client({ name: 'test-chatgpt', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.localBase}/r/${srv.room.code}/mcp`)));
  const { tools } = await client.listTools();
  for (const name of ['join_room', 'wait_for_updates', 'ask_member', 'finish_task', 'read_file', 'edit_file', 'share_file', 'get_asset']) {
    assert.ok(tools.some((t) => t.name === name), `missing tool ${name}`);
  }
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content?.[0]?.text);
    return r;
  };
  const parse = (r) => JSON.parse(r.content[0].text);

  const joined = parse(await call('join_room', { name: 'ChatGPT', app: 'ChatGPT desktop', capabilities: ['image-generation', 'web-search'] }));
  assert.equal(joined.role, 'member');
  await call('send_message', { text: 'hi team, ChatGPT here' });
  const file = parse(await call('read_file', { path: 'index.js' }));
  assert.match(file.content, /console\.log/);
  await call('claim_file', { path: 'index.js' });
  await call('edit_file', { path: 'index.js', old_text: 'console.log', new_text: 'console.info' });
  await call('release_file', { path: 'index.js' });
  assert.match(fs.readFileSync(path.join(projectDir, 'index.js'), 'utf8'), /console\.info/);

  // 1x1 PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const shared = parse(await call('share_file', { base64: png, name: 'icon.png', message: 'icon draft' }));
  const img = await call('get_asset', { asset_id: shared.asset.id });
  assert.equal(img.content[0].type, 'image');
  assert.equal(img.content[0].mimeType, 'image/png');

  const status = parse(await call('room_status', {}));
  assert.ok(status.members.some((m) => m.name === 'ChatGPT' && m.access === 'remote'));
  const waited = parse(await call('wait_for_updates', { timeout_seconds: 0 }));
  assert.ok(Array.isArray(waited.new_messages));
  await client.close();
});
