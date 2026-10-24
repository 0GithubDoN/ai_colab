// Public link via a free Cloudflare quick tunnel (no account, no domain).
// Only needed for apps whose AI runs in the cloud (ChatGPT, Claude.ai web):
// their servers call the room, so they cannot reach "localhost" on your PC.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function assetName() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch];
  if (!arch) throw new Error(`No cloudflared build for ${process.arch}.`);
  if (process.platform === 'win32') return `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  throw new Error(`Public links are not supported on ${process.platform}.`);
}

function onPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['cloudflared'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Find cloudflared, downloading it into <home>/bin the first time. */
export async function ensureCloudflared(home, log = () => {}) {
  if (process.env.CREWROOM_CLOUDFLARED) return process.env.CREWROOM_CLOUDFLARED;
  const system = onPath();
  if (system) return system;
  const binDir = path.join(home, 'bin');
  const bin = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(binDir, { recursive: true });
  const asset = assetName();
  log(`Downloading cloudflared (${asset}) once...`);
  const res = await fetch(`${RELEASE}/${asset}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download cloudflared (HTTP ${res.status}).`);
  const data = Buffer.from(await res.arrayBuffer());
  if (asset.endsWith('.tgz')) {
    const tgz = path.join(binDir, asset);
    fs.writeFileSync(tgz, data);
    execFileSync('tar', ['-xzf', tgz, '-C', binDir]);
    fs.rmSync(tgz, { force: true });
  } else {
    fs.writeFileSync(bin, data);
  }
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

/** Start a quick tunnel to a local URL. Resolves with { url, stop }. */
export async function startTunnel({ home, localUrl, log = () => {} }) {
  const bin = await ensureCloudflared(home, log);
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let output = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`cloudflared did not give a public URL within 45s.\n${output.slice(-800)}`));
      }
    }, 45_000);
    const scan = (chunk) => {
      output += chunk;
      if (settled) return;
      // The tunnel URL looks like https://some-random-words.trycloudflare.com ("api." is cloudflared's own API).
      const m = output.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
      const failed = output.match(/failed to request quick Tunnel[^\n]*/i);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], proc, stop: () => proc.kill() });
      } else if (failed) {
        settled = true;
        clearTimeout(timer);
        proc.kill();
        reject(new Error(`Cloudflare could not create a public link (${failed[0].replace(/^failed to request quick Tunnel:?\s*/i, '')}). Check your internet connection or firewall.`));
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (${code}).\n${output.slice(-800)}`));
      }
    });
  });
}
