import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room, HUMAN } from '../src/room.js';

const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewroom-p-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("hello");\n');
  return dir;
};

async function setup(...names) {
  const room = new Room({ projectRoot: tmpProject() });
  const members = [];
  for (const [i, n] of names.entries()) {
    const r = await room.call('join', null, { name: n, app: `${n} app`, lead: i === 0 });
    members.push(room.memberByToken(r.your_token));
  }
  for (const m of members) await room.call('wait', m, { timeout_seconds: 0 });
  return { room, members };
}

test('ask -> finish routes the result back to the asker, with attachments', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  assert.equal(room.s.leadId, claude.id);
  const { task } = await room.call('ask', claude, { to: 'ChatGPT', title: 'Make an icon', kind: 'asset' });
  assert.equal(task.status, 'assigned');
  const forGpt = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.equal(forGpt.your_tasks[0].id, task.id);
  assert.match(forGpt.guidance, /talking to you directly/);

  const shared = await room.call('share_file', gpt, { base64: Buffer.from('PNGDATA').toString('base64'), name: 'icon.png', message: false });
  await room.call('finish_task', gpt, { task_id: task.id, result: 'Here it is', attachments: [shared.asset.id] });
  const forClaude = await room.call('wait', claude, { timeout_seconds: 0 });
  const result = forClaude.new_messages.find((m) => m.kind === 'result');
  assert.equal(result.from, 'ChatGPT');
  assert.equal(result.to, 'Claude');
  assert.equal(result.attachments[0].name, 'icon.png');

  await room.call('save_asset', claude, { asset_id: shared.asset.id, path: 'public/icon.png' });
  assert.equal(fs.readFileSync(path.join(room.projectRoot, 'public/icon.png'), 'utf8'), 'PNGDATA');
  room.close();
});

test('wait blocks until a message arrives, and mentions are flagged', async () => {
  const { room, members: [a, b] } = await setup('A', 'B');
  const started = Date.now();
  const pending = room.call('wait', b, { timeout_seconds: 5 });
  setTimeout(() => room.call('send', a, { text: 'ping @B' }), 100);
  const r = await pending;
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.new_messages.at(-1).text, 'ping @B');
  assert.equal(r.new_messages.at(-1).mentions_you, true);
  room.close();
});

test('file claims protect files; paths stay inside the project', async () => {
  const { room, members: [a, b] } = await setup('A', 'B');
  await room.call('claim_file', a, { path: 'index.js' });
  await assert.rejects(room.call('edit_file', b, { path: 'index.js', old_text: 'hello', new_text: 'hi' }), /being edited by A/);
  await room.call('edit_file', a, { path: path.join(room.projectRoot, 'index.js'), old_text: 'hello', new_text: 'hi' });
  assert.match(fs.readFileSync(path.join(room.projectRoot, 'index.js'), 'utf8'), /hi/);
  await assert.rejects(room.call('read_file', a, { path: '../../etc/passwd' }), /outside the project/);
  await assert.rejects(room.call('read_file', a, { path: '/etc/passwd' }), /outside the project/);
  await assert.rejects(room.call('write_file', a, { path: '.crewroom/room.json', content: '{}' }), /managed automatically/);
  await assert.rejects(room.call('write_file', a, { path: '.git/config', content: '' }), /managed automatically/);
  room.close();
});

test('file history and restore undo an edit', async () => {
  const { room, members: [a] } = await setup('A');
  await room.call('write_file', a, { path: 'index.js', content: 'broken\n' });
  const { versions } = await room.call('file_history', a, { path: 'index.js' });
  assert.equal(versions.length, 1);
  await room.call('restore_file', a, { path: 'index.js' });
  assert.match(fs.readFileSync(path.join(room.projectRoot, 'index.js'), 'utf8'), /hello/);
  room.close();
});

test('restore works even when the edit and the restore happen in the same millisecond', async () => {
  const { room, members: [a] } = await setup('A');
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    await room.call('write_file', a, { path: 'index.js', content: 'broken\n' });
    await room.call('restore_file', a, { path: 'index.js' });
  } finally {
    Date.now = realNow;
  }
  assert.match(fs.readFileSync(path.join(room.projectRoot, 'index.js'), 'utf8'), /hello/);
  assert.equal((await room.call('file_history', a, { path: 'index.js' })).versions.length, 2);
  room.close();
});

test('lead away: explicit and detected by silence; members are told to finish and wait', async () => {
  const { room, members: [lead, g] } = await setup('Claude', 'Gemini');
  await room.call('ask', lead, { to: 'Gemini', title: 'Write tests' });
  await room.call('set_activity', lead, { status: 'away', activity: 'out of tokens' });
  let r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.equal(r.lead.status, 'away');
  assert.match(r.guidance, /lead \(Claude\) is away\. Finish your 1 task/);

  await room.call('status', lead); // any activity brings the lead back
  r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.ok(r.new_messages.some((m) => /Claude is back/.test(m.text)));
  assert.equal(r.new_messages.filter((m) => /back/.test(m.text)).length, 1, 'announced once');

  // Silence: lead not seen for longer than leadAwayMinutes.
  room._tick();
  lead.lastSeen = Date.now() - 11 * 60_000;
  room._tick();
  r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.ok(r.new_messages.some((m) => /seems to be away/.test(m.text)));
  await room.call('send', lead, { text: 'back!' });
  r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.ok(r.new_messages.some((m) => /lead \(Claude\) is back/.test(m.text)));
  room.close();
});

test('only the lead or the human can do lead things', async () => {
  const { room, members: [, g] } = await setup('Claude', 'Gemini');
  await assert.rejects(room.call('set_brief', g, { brief: 'x' }), /Only the lead/);
  await room.call('set_lead', HUMAN, { name: 'Gemini' });
  assert.equal(room.leadStatus().name, 'Gemini');
  await assert.rejects(room.call('update_settings', g, { commands: 'auto' }), /Only the human/);
  room.close();
});

test('an active member name cannot be taken over; an inactive one can rejoin', async () => {
  const { room, members: [a] } = await setup('Claude');
  await assert.rejects(room.call('join', null, { name: 'claude' }), /already in the room/);
  a.lastSeen = Date.now() - 10 * 60_000;
  const r = await room.call('join', null, { name: 'Claude', app: 'new chat' });
  assert.equal(r.your_token, a.token);
  room.close();
});

test('commands need the human: ask -> approve runs it; deny; off', async () => {
  const { room, members: [, g] } = await setup('Claude', 'ChatGPT');
  const pending = room.call('run_command', g, { command: 'echo crewroom-ok', wait_seconds: 10 });
  await new Promise((r) => setTimeout(r, 50));
  const c = room.s.commands.at(-1);
  assert.equal(c.status, 'pending');
  await room.call('approve_command', HUMAN, { command_id: c.id, approve: true });
  const result = await pending;
  assert.equal(result.status, 'finished');
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /crewroom-ok/);

  const pending2 = room.call('run_command', g, { command: 'echo nope', wait_seconds: 10 });
  await new Promise((r) => setTimeout(r, 50));
  await room.call('approve_command', HUMAN, { command_id: room.s.commands.at(-1).id, approve: false });
  assert.equal((await pending2).status, 'denied');

  await room.call('update_settings', HUMAN, { commands: 'off' });
  await assert.rejects(room.call('run_command', g, { command: 'echo x' }), /turned off/);
  room.close();
});

test('nothing is written after close(), even with a command still waiting for approval', async () => {
  const { room, members: [, g] } = await setup('Claude', 'ChatGPT');
  await room.call('run_command', g, { command: 'echo hi', wait_seconds: 0 });
  room.close();
  assert.equal(JSON.parse(fs.readFileSync(room.stateFile, 'utf8')).commands.at(-1).status, 'expired');
  fs.rmSync(room.dataDir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(room.stateFile), false);
});

test('flood guard slows down a chatty agent', async () => {
  const { room, members: [a] } = await setup('A');
  for (let i = 0; i < 25; i++) await room.call('send', a, { text: `m${i}` });
  await assert.rejects(room.call('send', a, { text: 'too many' }), /Slow down/);
  room.close();
});

test('state survives a restart (same code, members, transient fields not saved)', async () => {
  const { room, members: [a] } = await setup('A');
  a._waiting = 3;
  room.close();
  const again = new Room({ projectRoot: room.projectRoot });
  assert.equal(again.code, room.code);
  assert.equal(again.memberByName('A').token, a.token);
  assert.equal(again.memberByName('A')._waiting, undefined);
  again.close();
});
