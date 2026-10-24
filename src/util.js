// Small shared helpers: paths, ids, safe downloads, opening the browser.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const CLI_PATH = fileURLToPath(new URL('../bin/crewroom.js', import.meta.url));
export const DEFAULT_PORT = 7777;
export const PROJECT_DIR = '.crewroom';

/** Global folder for the hub (~/.crewroom). Override with CREWROOM_HOME. */
export function homeDir() {
  const dir = process.env.CREWROOM_HOME || path.join(os.homedir(), '.crewroom');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const hubFile = (home = homeDir()) => path.join(home, 'hub.json');

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data, { mode, replacer } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, replacer, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export const secret = (bytes = 18) => randomBytes(bytes).toString('base64url');
export const shortId = (n = 6) => randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A 12-character room code like K7QF-9M2D-TX4P (~60 bits). */
export function newRoomCode() {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Accepts a code in any case/format, or a full invite link, and returns the canonical code. */
export function normalizeCode(input) {
  if (!input) return null;
  let s = String(input).trim();
  const m = s.match(/\/r\/([A-Za-z0-9-]+)/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 12) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/**
 * Download a URL into memory. Refuses local/private network addresses (unless
 * CREWROOM_ALLOW_PRIVATE_FETCH=1) so a room member cannot make the hub read
 * things from your local network.
 */
export async function download(url, { maxBytes = 25 * 1024 * 1024 } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  let res;
  // Follow redirects by hand so every hop is checked.
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs can be downloaded.');
    if (process.env.CREWROOM_ALLOW_PRIVATE_FETCH !== '1') {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
      if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Downloading from local/private network addresses is not allowed.');
    }
    res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop >= 5) throw new Error('Too many redirects.');
      u = new URL(loc, u);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`File too large (${Math.round(len / 1e6)} MB).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('File too large.');
  const cd = res.headers.get('content-disposition') || '';
  const name = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] || path.basename(u.pathname) || 'download';
  return { buffer, mime: (res.headers.get('content-type') || '').split(';')[0] || undefined, name: decodeURIComponent(name) };
}

export function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

export function guessMime(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
    '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain', '.py': 'text/plain', '.zip': 'application/zip',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  }[ext] || 'application/octet-stream';
}

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
