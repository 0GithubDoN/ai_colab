import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crewroom.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const home = tmp('crewroom-h-');
const fakeUserHome = tmp('crewroom-u-');
const project = tmp('crewroom-p-');
const env = { ...process.env, CREWROOM_HOME: home, CREWROOM_PORT: '0', HOME: fakeUserHome, USERPROFILE: fakeUserHome };
const cli = (args, opts = {}) => run(process.execPath, [CLI, ...args], { cwd: project, env, ...opts });

before(() => fs.writeFileSync(path.join(project, 'README.md'), '# demo\n'));
after(async () => { await cli(['stop', '--all']).catch(() => {}); });

test('start runs the hub in the background and prints links; agents talk through the CLI', async () => {
  const { stdout } = await cli(['start', '--name', 'Demo', '--json']);
  const links = JSON.parse(stdout);
  assert.match(links.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(links.dashboard, /dashboard\?key=/);
  assert.ok(fs.existsSync(path.join(project, '.crewroom', 'room.json')));
  assert.equal(fs.readFileSync(path.join(project, '.crewroom', '.gitignore'), 'utf8').includes('*'), true);

  assert.match((await cli(['join', '--name', 'Claude', '--app', 'Claude Code', '--lead'])).stdout, /Role: lead/);
  await cli(['join', '--name', 'Codex', '--app', 'Codex', '--caps', 'terminal']);
  await cli(['wait', '--as', 'Codex', '--timeout', '0']);
  await cli(['ask', '--as', 'Claude', '--to', 'Codex', '--kind', 'review', 'Review README.md']);
  const w = await cli(['wait', '--as', 'Codex', '--timeout', '3']);
  assert.match(w.stdout, /\[T1 · review for Codex\] Review README.md/);
  assert.match(w.stdout, /--- your tasks ---/);
  await cli(['done', '--as', 'Codex', 'T1', 'Looks good']);
  const w2 = await cli(['wait', '--as', 'Claude', '--timeout', '3']);
  assert.match(w2.stdout, /\[T1 done\] Review README.md\n\s+Looks good/);

  // Running from a subfolder finds the room too.
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const st = await cli(['status', '--as', 'Claude'], { cwd: path.join(project, 'src') });
  assert.equal(JSON.parse(st.stdout).room, 'Demo');
});

test('stdio bridge: an app joins with the code, and survives a hub restart', async () => {
  const links = JSON.parse((await cli(['links', '--json'])).stdout);
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'pipe' });
  const client = new Client({ name: 'claude-desktop-sim', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content?.[0]?.text);
    return JSON.parse(r.content[0].text);
  };
  const joined = await call('join_room', { invite: links.code, name: 'ChatGPT', app: 'ChatGPT desktop' });
  await call('send_message', { text: 'hello via stdio' });

  // Restart the hub underneath the bridge.
  await cli(['stop', '--all']);
  await new Promise((r) => setTimeout(r, 300));
  const st = await call('room_status', { token: joined.your_token });
  assert.equal(st.you, 'ChatGPT');
  assert.equal(st.room, 'Demo');
  await client.close();
});

test('connect writes app configs (JSON + TOML), keeps other servers, and disconnect removes them', async () => {
  fs.mkdirSync(path.join(fakeUserHome, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  fs.mkdirSync(path.join(fakeUserHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "y"\n');

  const { stdout } = await cli(['connect', 'cursor', 'codex', '--yes']);
  assert.match(stdout, /✓ Cursor/);
  assert.match(stdout, /✓ Codex/);
  const cursor = JSON.parse(fs.readFileSync(path.join(fakeUserHome, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursor.mcpServers.other.command, 'x');
  assert.deepEqual(cursor.mcpServers.crewroom.args.slice(-1), ['mcp']);
  const toml = fs.readFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.crewroom\]\ncommand = ".*"\nargs = \[".*crewroom\.js", "mcp"\]/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.ok(fs.existsSync(path.join(fakeUserHome, '.cursor', 'mcp.json.crewroom-backup')));

  // Running it twice does not duplicate anything.
  await cli(['connect', 'codex', '--yes']);
  assert.equal(fs.readFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'utf8').split('[mcp_servers.crewroom]').length, 2);

  // A config we cannot parse is never overwritten.
  fs.mkdirSync(path.join(fakeUserHome, '.codeium', 'windsurf'), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, '.codeium', 'windsurf', 'mcp_config.json'), '{ // comment\n}');
  const ws = await cli(['connect', 'windsurf', '--yes']);
  assert.match(ws.stdout, /✗ Windsurf: could not edit/);
  assert.equal(fs.readFileSync(path.join(fakeUserHome, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'), '{ // comment\n}');

  await cli(['disconnect', 'cursor', 'codex', '--yes']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fakeUserHome, '.cursor', 'mcp.json'), 'utf8')).mcpServers.crewroom, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'utf8'), /crewroom/);
});
