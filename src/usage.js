// Token usage and model info, read from the local logs that some AI apps
// write on this computer. Nothing is sent anywhere; only the dashboard shows it.
//
//  - Codex (app/CLI/IDE): ~/.codex/sessions/**/rollout-*.jsonl has the model,
//    token totals, context window and the 5-hour / weekly limit percentages.
//  - Claude Code (CLI and the Code tab of Claude desktop): ~/.claude/projects/**/<session>.jsonl
//    has the model and per-message token usage. Its 5-hour / weekly limits are only
//    given to a status line command, which `crewroom statusline` forwards to the hub.
//  - Cloud chat apps (ChatGPT, Claude.ai) keep nothing locally; they can self-report.
//
// The log formats are not official APIs, so every field is optional.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const RECENT_MS = 3 * 3600_000; // only sessions touched in the last 3 hours
const TAIL_BYTES = 512 * 1024;

const codexHome = () => process.env.CREWROOM_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const claudeHome = () => process.env.CREWROOM_CLAUDE_HOME || path.join(os.homedir(), '.claude');

function readHead(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, bytes = TAIL_BYTES) {
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return '';
    return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8').slice(-bytes);
  }
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text; // drop the partial first line
  } finally {
    fs.closeSync(fd);
  }
}

function jsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function recentFiles(dir, match, { maxDepth = 5, since = Date.now() - RECENT_MS } = {}) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (match(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= since) out.push({ file: full, mtime: st.mtimeMs });
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

const inside = (dir, root) => {
  if (!dir) return false;
  const a = path.resolve(String(dir));
  const b = path.resolve(root);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + path.sep);
  return a === b || a.startsWith(b + path.sep);
};

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined);
const epochMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined);

/** Turn a window like {used_percent, window_minutes, resets_at} into our shape. */
function codexWindow(w, now) {
  if (!w || typeof w !== 'object') return null;
  const used = pct(w.used_percent ?? w.usedPercent);
  if (used === undefined) return null;
  let resetsAt = epochMs(w.resets_at ?? w.resetsAt);
  if (!resetsAt && typeof w.resets_in_seconds === 'number') resetsAt = now + w.resets_in_seconds * 1000;
  return { used, resetsAt, minutes: w.window_minutes ?? w.windowMinutes };
}

function limitsFromWindows(windows) {
  const limits = {};
  for (const w of windows.filter(Boolean)) {
    // Label by window length, not by "primary/secondary" slot.
    if (w.minutes && w.minutes >= 6 * 24 * 60) limits.weekly = w;
    else if (w.minutes && w.minutes <= 12 * 60) limits.session = w;
    else if (!limits.session) limits.session = w;
    else limits.weekly ||= w;
  }
  return limits;
}

export function parseCodexRollout(head, tail, now = Date.now()) {
  const first = jsonLines(head).find((l) => l.type === 'session_meta');
  const meta = first?.payload || {};
  const lines = jsonLines(tail);
  let model;
  let tokenInfo;
  let rateLimits;
  let ts;
  for (const l of lines) {
    const p = l.payload || {};
    if (l.type === 'turn_context' && p.model) model = p.model;
    if (l.type === 'event_msg' && p.type === 'token_count') {
      if (p.info) tokenInfo = p.info;
      if (p.rate_limits) rateLimits = p.rate_limits;
      ts = l.timestamp || ts;
    }
  }
  const total = tokenInfo?.total_token_usage || {};
  const last = tokenInfo?.last_token_usage || {};
  const window = tokenInfo?.model_context_window;
  const contextUsed = last.input_tokens ?? undefined;
  return {
    source: 'codex',
    sessionId: meta.id,
    cwd: meta.cwd,
    model,
    tokensIn: total.input_tokens,
    tokensCached: total.cached_input_tokens,
    tokensOut: (total.output_tokens || 0) + (total.reasoning_output_tokens || 0) || undefined,
    contextPct: window && contextUsed !== undefined ? pct((contextUsed / window) * 100) : undefined,
    contextWindow: window,
    limits: rateLimits ? limitsFromWindows([codexWindow(rateLimits.primary, now), codexWindow(rateLimits.secondary, now)]) : undefined,
    plan: rateLimits?.plan_type,
    updatedAt: epochMs(ts),
  };
}

export function parseClaudeTranscript(tail, sessionIdFromName) {
  const lines = jsonLines(tail);
  let model;
  let cwd;
  let sessionId = sessionIdFromName;
  let lastUsage;
  let ts;
  let tokensOut = 0;
  let tokensIn = 0;
  for (const l of lines) {
    if (l.cwd) cwd = l.cwd;
    if (l.sessionId) sessionId = l.sessionId;
    const m = l.message;
    if (l.type === 'assistant' && m && typeof m === 'object') {
      if (m.model && m.model !== '<synthetic>') model = m.model;
      if (m.usage) {
        lastUsage = m.usage;
        tokensOut += m.usage.output_tokens || 0;
        tokensIn += (m.usage.input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
      }
      ts = l.timestamp || ts;
    }
  }
  const context = lastUsage ? (lastUsage.input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0) : undefined;
  // Claude models have a 200k window unless running with the 1M context option.
  const window = context > 200_000 || /\[1m\]|1m/i.test(model || '') ? 1_000_000 : 200_000;
  return {
    source: 'claude-code',
    sessionId,
    cwd,
    model,
    tokensIn: tokensIn || undefined,
    tokensOut: tokensOut || undefined,
    contextPct: context !== undefined ? pct((context / window) * 100) : undefined,
    contextWindow: window,
    updatedAt: epochMs(ts),
  };
}

/** Map a Claude Code status line payload (stdin JSON) to our shape. */
export function parseClaudeStatusline(j, now = Date.now()) {
  const rl = j.rate_limits || {};
  const w = (x, minutes) => (x && pct(x.used_percentage) !== undefined ? { used: pct(x.used_percentage), resetsAt: epochMs(x.resets_at), minutes } : null);
  const cw = j.context_window || {};
  const limits = {};
  const session = w(rl.five_hour, 300);
  const weekly = w(rl.seven_day, 10080);
  if (session) limits.session = session;
  if (weekly) limits.weekly = weekly;
  return {
    source: 'claude-code',
    via: 'statusline',
    sessionId: j.session_id,
    cwd: j.workspace?.current_dir || j.cwd,
    projectDir: j.workspace?.project_dir,
    model: j.model?.display_name || j.model?.id,
    modelId: j.model?.id,
    contextPct: pct(cw.used_percentage),
    contextWindow: cw.context_window_size,
    tokensIn: cw.total_input_tokens,
    tokensOut: cw.total_output_tokens,
    costUsd: j.cost?.total_cost_usd,
    limits: Object.keys(limits).length ? limits : undefined,
    updatedAt: now,
  };
}

/** All recent usage entries for apps working in projectRoot. */
export function collectUsage(projectRoot, { statusline = [] } = {}) {
  const entries = [];
  const now = Date.now();

  for (const { file } of recentFiles(path.join(codexHome(), 'sessions'), (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n)).slice(0, 40)) {
    try {
      const head = file.endsWith('.zst') ? readTail(file, 64 * 1024 * 1024).slice(0, 64 * 1024) : readHead(file);
      const e = parseCodexRollout(head, readTail(file), now);
      if (inside(e.cwd, projectRoot)) entries.push({ ...e, file });
    } catch {}
  }

  for (const { file } of recentFiles(path.join(claudeHome(), 'projects'), (n) => n.endsWith('.jsonl'), { maxDepth: 2 }).slice(0, 40)) {
    try {
      const e = parseClaudeTranscript(readTail(file), path.basename(file, '.jsonl'));
      if (inside(e.cwd, projectRoot)) entries.push({ ...e, file });
    } catch {}
  }

  // Status line reports carry Claude Code's limits; merge them into the matching transcript entry.
  for (const s of statusline) {
    if (!inside(s.cwd, projectRoot) && !inside(s.projectDir, projectRoot)) continue;
    const match = entries.find((e) => e.source === 'claude-code' && e.sessionId && e.sessionId === s.sessionId);
    if (match) Object.assign(match, Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)), { updatedAt: Math.max(match.updatedAt || 0, s.updatedAt) });
    else entries.push(s);
  }
  return entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
