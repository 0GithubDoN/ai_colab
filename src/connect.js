// `crewroom connect`: add Crewroom to the AI apps installed on this computer,
// once. After that, the user just pastes an invite link/code into any chat.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CLI_PATH } from './util.js';

const SERVER = 'crewroom';
const H = os.homedir();

function appSupport() {
  if (process.platform === 'darwin') return path.join(H, 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(H, 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(H, '.config');
}

function claudeDesktopFiles() {
  const files = [path.join(appSupport(), 'Claude', 'claude_desktop_config.json')];
  // Microsoft Store build keeps its config inside the package folder.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const pk = path.join(process.env.LOCALAPPDATA, 'Packages');
    try {
      for (const d of fs.readdirSync(pk)) {
        if (/claude/i.test(d)) files.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
      }
    } catch {}
  }
  return files;
}

export function serverEntry(app) {
  const entry = { command: process.execPath, args: [CLI_PATH, 'mcp', ...(app?.args || [])] };
  if (process.env.CREWROOM_HOME) entry.env = { CREWROOM_HOME: process.env.CREWROOM_HOME };
  return entry;
}

const dirExists = (f) => fs.existsSync(path.dirname(f));
// --lite: the app edits files with its own tools, so it gets the room tools without the file
// tools (fewer tool definitions resent with every request). --wait: how long one
// wait_for_updates may block in this app; longer = fewer checks = fewer tokens.
const LITE = ['--lite'];

export const APPS = [
  { id: 'claude-desktop', label: 'Claude desktop app', type: 'json', key: 'mcpServers', files: claudeDesktopFiles, detect: dirExists, after: 'Fully quit Claude desktop (menu bar / tray icon → Quit) and open it again.' },
  { id: 'claude-code', label: 'Claude Code', type: 'claude-cli', args: [...LITE, '--wait', '600'], after: 'Start a new Claude Code session (or run /mcp to check).' },
  { id: 'codex', label: 'Codex (app, CLI and IDE extension)', type: 'toml', args: [...LITE, '--wait', '1500'], toolTimeoutSec: 1800, files: () => [path.join(process.env.CODEX_HOME || path.join(H, '.codex'), 'config.toml')], detect: dirExists, after: 'Restart Codex.' },
  {
    id: 'antigravity', label: 'Antigravity', type: 'json', key: 'mcpServers', args: LITE,
    files: () => [path.join(H, '.gemini', 'config', 'mcp_config.json'), path.join(H, '.gemini', 'antigravity', 'mcp_config.json')],
    detect: dirExists, after: 'In Antigravity open the MCP servers panel and press Refresh (or restart Antigravity).',
  },
  { id: 'cursor', label: 'Cursor', type: 'json', key: 'mcpServers', args: LITE, files: () => [path.join(H, '.cursor', 'mcp.json')], detect: dirExists, after: 'Restart Cursor (or toggle the server in Settings → MCP).' },
  { id: 'windsurf', label: 'Windsurf', type: 'json', key: 'mcpServers', args: LITE, files: () => [path.join(H, '.codeium', 'windsurf', 'mcp_config.json')], detect: dirExists, after: 'Press Refresh in Windsurf\'s MCP panel.' },
  { id: 'vscode', label: 'VS Code (Copilot agent mode)', type: 'json', key: 'servers', vscode: true, args: LITE, files: () => [path.join(appSupport(), 'Code', 'User', 'mcp.json')], detect: dirExists, after: 'Reload VS Code; start the "crewroom" server from the MCP view if asked.' },
  { id: 'gemini-cli', label: 'Gemini CLI', type: 'json', key: 'mcpServers', args: [...LITE, '--wait', '1500'], timeoutMs: 1_800_000, files: () => [path.join(H, '.gemini', 'settings.json')], detect: (f) => fs.existsSync(f), after: 'Restart Gemini CLI (or run /mcp to check).' },
];

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    return out || null;
  } catch {
    return null;
  }
}

function backup(file) {
  const b = `${file}.crewroom-backup`;
  if (fs.existsSync(file) && !fs.existsSync(b)) fs.copyFileSync(file, b);
}

function readConfigJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on comments/invalid JSON -> we never overwrite what we cannot read
}

function jsonEntry(app) {
  const e = serverEntry(app);
  if (app.timeoutMs) e.timeout = app.timeoutMs;
  return app.vscode ? { type: 'stdio', ...e } : e;
}

function tomlBlock(app) {
  const e = serverEntry(app);
  const lines = [
    `[mcp_servers.${SERVER}]`,
    `command = ${JSON.stringify(e.command)}`,
    `args = [${e.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    'startup_timeout_sec = 30',
    `tool_timeout_sec = ${app.toolTimeoutSec || 300}`,
  ];
  if (e.env) lines.push(`env = { CREWROOM_HOME = ${JSON.stringify(e.env.CREWROOM_HOME)} }`);
  return lines.join('\n');
}

function tomlReplace(text, block) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[mcp_servers.${SERVER}]`);
  if (start === -1) return block === null ? text : `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${block}\n`;
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim().startsWith('[') && !lines[end].trim().startsWith(`[mcp_servers.${SERVER}.`))) end++;
  const replacement = block === null ? [] : [...block.split('\n'), ''];
  lines.splice(start, end - start, ...replacement);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Claude Code shows its 5-hour / weekly limits only to a status line command. Install ours
 * (it prints model · context · limits and forwards them to the dashboard), unless the user
 * already has a status line of their own, which we never replace.
 */
export function claudeStatusline({ remove = false }) {
  const file = path.join(process.env.CREWROOM_CLAUDE_HOME || path.join(H, '.claude'), 'settings.json');
  let cfg;
  try {
    cfg = readConfigJson(file);
  } catch {
    return { ok: false, message: `could not read ${file}; status line not changed` };
  }
  const ours = (c) => /crewroom/.test(String(c?.command || ''));
  if (remove) {
    if (!ours(cfg.statusLine)) return null;
    delete cfg.statusLine;
  } else {
    if (cfg.statusLine && !ours(cfg.statusLine)) {
      return { ok: true, message: `you already have a Claude Code status line, so it was left alone. To show usage on the dashboard, use "${process.execPath}" "${CLI_PATH}" statusline as your status line command.` };
    }
    cfg.statusLine = { type: 'command', command: `"${process.execPath}" "${CLI_PATH}" statusline` };
  }
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { ok: true, message: remove ? `removed the Crewroom status line from ${file}` : `status line added (model · context · 5-hour · weekly) in ${file}` };
}

/** Which apps look installed, and whether Crewroom is already set up in them. */
export function appStatus() {
  return APPS.map((app) => {
    if (app.type === 'claude-cli') {
      const bin = which('claude');
      return { app, installed: !!bin, configured: null, files: [] };
    }
    const files = app.files().filter((f) => app.detect(f));
    let configured = false;
    for (const f of files) {
      try {
        if (app.type === 'toml') configured ||= fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(`[mcp_servers.${SERVER}]`);
        else configured ||= !!readConfigJson(f)?.[app.key]?.[SERVER];
      } catch {}
    }
    return { app, installed: files.length > 0, configured, files };
  });
}

/** Add (or with remove=true, remove) Crewroom in one app. Returns a list of human-readable results. */
export function configureApp(app, { remove = false } = {}) {
  const results = [];
  if (app.type === 'claude-cli') {
    const bin = which('claude');
    const e = serverEntry(app);
    const manual = `claude mcp add --scope user ${SERVER} -- "${e.command}" "${e.args.join('" "')}"`;
    if (!bin) return [{ ok: false, message: `Claude Code CLI not found. If you use Claude Code, run:\n    ${manual}` }];
    // On Windows `claude` is usually a .cmd shim, which needs a shell (and quoted arguments).
    const shell = process.platform === 'win32' && !/\.exe$/i.test(bin);
    const run = (args) => execFileSync(shell ? `"${bin}"` : bin, shell ? args.map((a) => (/[\s&()]/.test(a) ? `"${a}"` : a)) : args, { stdio: ['ignore', 'pipe', 'pipe'], shell });
    try { run(['mcp', 'remove', '--scope', 'user', SERVER]); } catch {}
    if (remove) return [{ ok: true, message: 'removed from Claude Code' }, claudeStatusline({ remove: true })].filter(Boolean);
    try {
      run(['mcp', 'add', '--scope', 'user', SERVER, '--', e.command, ...e.args]);
      return [{ ok: true, message: 'added to Claude Code (user scope)' }, claudeStatusline({})].filter(Boolean);
    } catch (err) {
      return [{ ok: false, message: `claude mcp add failed (${String(err.stderr || err.message).trim()}). Run it yourself:\n    ${manual}` }];
    }
  }

  const files = app.files().filter((f) => app.detect(f));
  if (!files.length) return [{ ok: false, message: `${app.label} does not seem to be installed.` }];
  for (const file of files) {
    try {
      if (app.type === 'toml') {
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const next = tomlReplace(text, remove ? null : tomlBlock(app));
        if (next !== text) {
          backup(file);
          fs.writeFileSync(file, next);
        }
      } else {
        const cfg = readConfigJson(file);
        if (remove) {
          if (!cfg[app.key]?.[SERVER]) continue;
          delete cfg[app.key][SERVER];
        } else {
          cfg[app.key] = { ...(cfg[app.key] || {}), [SERVER]: jsonEntry(app) };
        }
        backup(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
      }
      results.push({ ok: true, message: `${remove ? 'removed from' : 'updated'} ${file}` });
    } catch (err) {
      const snippet = app.type === 'toml' ? tomlBlock(app) : JSON.stringify({ [app.key]: { [SERVER]: jsonEntry(app) } }, null, 2);
      results.push({ ok: false, message: `could not edit ${file} (${err.message}). Add this yourself:\n${snippet}` });
    }
  }
  return results;
}
