// Finding (or starting) the local hub, and talking to it.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { homeDir, hubFile, readJson, CLI_PATH, DEFAULT_PORT, PROJECT_DIR, VERSION } from './util.js';

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Info of the running hub, or null. */
export async function runningHub(home = homeDir()) {
  const info = readJson(hubFile(home));
  if (!info?.port) return null;
  const h = await health(info.port);
  return h?.app === 'crewroom' && h.hubId === info.hubId ? { ...info, version: h.version } : null;
}

/** Make sure a hub is running in the background; start one if needed. */
export async function ensureHub({ home = homeDir(), port, quietSpawn = true } = {}) {
  let existing = await runningHub(home);
  // After an update, an old hub may still be running the old code: replace it. Rooms are
  // saved and reopen, and apps reconnect by themselves.
  if (existing && existing.version && existing.version !== VERSION) {
    await hubApi(existing, 'shutdown', {}).catch(() => {});
    for (let i = 0; i < 40 && (await runningHub(home)); i++) await new Promise((r) => setTimeout(r, 100));
    existing = null;
  }
  if (existing) return existing;
  const logFile = path.join(home, 'hub.log');
  const out = fs.openSync(logFile, 'a');
  const args = [CLI_PATH, 'hub'];
  const wanted = port ?? process.env.CREWROOM_PORT ?? DEFAULT_PORT;
  args.push('--port', String(wanted));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, CREWROOM_HOME: home },
  });
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const info = await runningHub(home);
    if (info) return info;
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-12).join('\n') : '';
  if (!quietSpawn) console.error(tail);
  throw new Error(`The Crewroom hub did not start. Log (${logFile}):\n${tail}`);
}

export async function hubApi(info, pathname, body, method = 'POST') {
  const res = await fetch(`http://127.0.0.1:${info.port}/hub/${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-hub-key': info.key },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Find the project folder that has a room (walking up from cwd). */
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, PROJECT_DIR, 'room.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
