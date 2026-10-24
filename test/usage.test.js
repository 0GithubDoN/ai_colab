import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexRollout, parseClaudeTranscript, parseClaudeStatusline, collectUsage } from '../src/usage.js';

const NOW = Date.parse('2026-10-24T22:00:00Z');
const codexLines = (cwd) => [
  { timestamp: '2026-10-24T21:00:00Z', type: 'session_meta', payload: { id: 'sess-1', cwd, originator: 'codex_cli_rs' } },
  { timestamp: '2026-10-24T21:00:01Z', type: 'turn_context', payload: { cwd, model: 'gpt-5.5-codex' } },
  { timestamp: '2026-10-24T21:59:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 120000, cached_input_tokens: 90000, output_tokens: 8000, reasoning_output_tokens: 2000 }, last_token_usage: { input_tokens: 68000 }, model_context_window: 272000 }, rate_limits: { primary: { used_percent: 23.5, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 64, window_minutes: 10080, resets_at: 1793000000 }, plan_type: 'plus' } } },
];
const claudeLines = (cwd) => [
  { type: 'user', cwd, sessionId: 'abc', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', cwd, sessionId: 'abc', timestamp: '2026-10-24T21:58:00Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 48000, output_tokens: 700 } } },
];
const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

test('Codex rollout: model, tokens, context and 5-hour / weekly limits by window length', () => {
  const text = jsonl(codexLines('/p'));
  const e = parseCodexRollout(text, text, NOW);
  assert.equal(e.model, 'gpt-5.5-codex');
  assert.equal(e.cwd, '/p');
  assert.equal(e.sessionId, 'sess-1');
  assert.equal(e.tokensOut, 10000);
  assert.equal(Math.round(e.contextPct), 25);
  assert.equal(e.limits.session.used, 23.5);
  assert.equal(e.limits.session.resetsAt, NOW + 3600_000);
  assert.equal(e.limits.weekly.used, 64);
  assert.equal(e.limits.weekly.resetsAt, 1793000000 * 1000);
  assert.equal(e.plan, 'plus');
});

test('Claude Code transcript: model, context from the last turn, tokens', () => {
  const e = parseClaudeTranscript(jsonl(claudeLines('/p')), 'abc');
  assert.equal(e.model, 'claude-opus-5-5');
  assert.equal(e.cwd, '/p');
  assert.equal(Math.round(e.contextPct), 25); // 50,010 of 200k
  assert.equal(e.tokensOut, 700);
});

test('Claude Code status line payload gives the limits', () => {
  const e = parseClaudeStatusline({ session_id: 'abc', workspace: { current_dir: '/p' }, model: { id: 'claude-opus-5-5', display_name: 'Opus' }, context_window: { used_percentage: 33 }, rate_limits: { five_hour: { used_percentage: 80, resets_at: 1793000000 }, seven_day: { used_percentage: 40 } } }, NOW);
  assert.equal(e.model, 'Opus');
  assert.equal(e.contextPct, 33);
  assert.equal(e.limits.session.used, 80);
  assert.equal(e.limits.weekly.used, 40);
});

test('collectUsage finds recent sessions for this project only and merges status line data', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewroom-u-'));
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(project);
  process.env.CREWROOM_CODEX_HOME = path.join(tmp, 'codex');
  process.env.CREWROOM_CLAUDE_HOME = path.join(tmp, 'claude');
  try {
    const day = path.join(tmp, 'codex', 'sessions', '2026', '10', '24');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), jsonl(codexLines(project)));
    fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), jsonl(codexLines(path.join(tmp, 'other'))));
    const cdir = path.join(tmp, 'claude', 'projects', '-proj');
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'abc.jsonl'), jsonl(claudeLines(path.join(project, 'src'))));
    const entries = collectUsage(project, { statusline: [{ source: 'claude-code', via: 'statusline', sessionId: 'abc', cwd: project, limits: { session: { used: 55 } }, updatedAt: Date.now() }] });
    assert.equal(entries.length, 2);
    const codex = entries.find((e) => e.source === 'codex');
    assert.equal(codex.limits.weekly.used, 64);
    const claude = entries.find((e) => e.source === 'claude-code');
    assert.equal(claude.model, 'claude-opus-5-5');
    assert.equal(claude.limits.session.used, 55);
  } finally {
    delete process.env.CREWROOM_CODEX_HOME;
    delete process.env.CREWROOM_CLAUDE_HOME;
  }
});

test('garbage and empty logs never throw', () => {
  assert.doesNotThrow(() => parseCodexRollout('not json\n{"type":"event_msg","payload":{}}', '', NOW));
  assert.doesNotThrow(() => parseClaudeTranscript('{broken', 'x'));
  assert.doesNotThrow(() => parseClaudeStatusline({}));
});

test('connect: Claude Code status line is added when missing, never replaces the user\'s own, and is removed cleanly', async () => {
  const { claudeStatusline } = await import('../src/connect.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewroom-c-'));
  process.env.CREWROOM_CLAUDE_HOME = dir;
  const file = path.join(dir, 'settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }));
    assert.match(claudeStatusline({}).message, /status line added/);
    let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(cfg.statusLine.command, /crewroom\.js" statusline$/);
    assert.equal(cfg.model, 'opus');
    claudeStatusline({ remove: true });
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cfg.statusLine, undefined);
    assert.deepEqual(cfg.permissions, { allow: ['Bash(ls)'] });

    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line.sh' } }));
    assert.match(claudeStatusline({}).message, /left alone/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'my-own-line.sh');
    assert.equal(claudeStatusline({ remove: true }), null);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'my-own-line.sh');
  } finally {
    delete process.env.CREWROOM_CLAUDE_HOME;
  }
});
