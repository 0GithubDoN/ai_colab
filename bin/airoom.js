#!/usr/bin/env node
// airoom CLI: start a room for a project, or take part in one as an agent.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(import.meta.url);
const BOOLEAN_FLAGS = new Set(['lead', 'all', 'json', 'decision', 'away', 'back', 'tunnel', 'replace-all', 'help']);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const HELP = `airoom - an AI team room for your project

Start a room (run in the project folder; the lead AI usually does this):
  airoom start [--port 7777] [--name "My Project"] [--host 127.0.0.1]
               [--tunnel]              (public link via cloudflared, for ChatGPT/Claude.ai connectors)
               [--public-url https://...]
  airoom links                          show invite / MCP / dashboard links again

Take part (run in the project folder):
  airoom join --name Claude --app "Claude desktop" --caps "terminal,local-files" [--lead]
  airoom wait --as Claude [--timeout 120] [--json]
  airoom say --as Claude [--to Gemini] "message"
  airoom ask --as Claude [--to ChatGPT] [--kind task|review|question|asset|research] [--details "..."] [--files a.js,b.js] "title"
  airoom take --as Gemini T2
  airoom done --as Gemini T2 "result" [--status done|blocked|cancelled] [--attach assetId,...]
  airoom tasks --as Claude [--all]
  airoom status --as Claude
  airoom claim --as Claude src/app.js [--note "refactor"]   |   airoom release --as Claude src/app.js
  airoom share --as Gemini icon.png [--to Claude] ["message"]
  airoom save --as Claude <assetId> public/icon.png
  airoom assets --as Claude
  airoom note --as Claude [--decision] "text"   |   airoom notes --as Claude
  airoom history --as Claude [--limit 50]
  airoom activity --as Claude "writing tests" [--away | --back]
  airoom brief --as Claude "what we are building"     (lead)
  airoom lead --as Claude Gemini                      (lead: hand over lead)
  airoom pause --as Claude | airoom resume --as Claude (lead)

Identity: --as <Name> uses the token saved by join in .airoom/agents/.
You can also use --token or the AIROOM_TOKEN env var, and --url / AIROOM_URL.
`;

function findDataDir(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, '.airoom', 'server.json'))) return path.join(dir, '.airoom');
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function connection(flags) {
  const dataDir = findDataDir();
  let url = flags.url || process.env.AIROOM_URL;
  let code = flags.code || process.env.AIROOM_CODE;
  if (url && /\/r\/[^/]+/.test(url)) {
    const m = url.match(/^(.*)\/r\/([^/]+)/);
    url = m[1];
    code = m[2];
  }
  if ((!url || !code) && dataDir) {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
    url = url || s.url;
    code = code || s.code;
  }
  if (!url || !code) die('No running room found. Run this in the project folder after `airoom start`, or pass --url <invite link>.');
  return { url, code, dataDir };
}

function agentFile(dataDir, name) {
  return path.join(dataDir || path.join(process.cwd(), '.airoom'), 'agents', `${String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}.json`);
}

function tokenFor(flags, dataDir) {
  if (flags.token) return flags.token;
  const name = flags.as || process.env.AIROOM_AS;
  if (name) {
    const f = agentFile(dataDir, name);
    if (!fs.existsSync(f)) die(`No saved identity for "${name}". Run: airoom join --name ${name} --app "<your app>"`);
    return JSON.parse(fs.readFileSync(f, 'utf8')).token;
  }
  if (process.env.AIROOM_TOKEN) return process.env.AIROOM_TOKEN;
  die('Who are you? Pass --as <YourName> (the name you joined with).');
}

async function api(conn, action, body, token, { admin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = admin;
  let res;
  try {
    res = await fetch(`${conn.url}/r/${conn.code}/api/${action}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  } catch (err) {
    die(`Cannot reach the room at ${conn.url} (${err.cause?.code || err.message}). Is \`airoom start\` still running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `HTTP ${res.status}`);
  return data;
}

function die(msg) {
  console.error(`airoom: ${msg}`);
  process.exit(1);
}

function print(obj, flags) {
  if (flags.json) return console.log(JSON.stringify(obj, null, 2));
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function formatWait(r) {
  const out = [];
  const lead = r.lead?.name ? `${r.lead.name} (${r.lead.status})` : 'none';
  out.push(`lead: ${lead}${r.paused ? ' | ROOM PAUSED' : ''}`);
  if (r.history?.length) {
    out.push('--- earlier ---');
    for (const m of r.history) out.push(fmtMsg(m));
  }
  if (r.new_messages.length) {
    out.push(`--- ${r.new_messages.length} new message(s) ---`);
    for (const m of r.new_messages) out.push(fmtMsg(m));
  } else out.push('--- no new messages ---');
  if (r.your_tasks.length) {
    out.push('--- your tasks ---');
    for (const t of r.your_tasks) out.push(`  ${t.id} [${t.kind}, ${t.status}] from ${t.from}: ${t.title}${t.details ? `\n      ${t.details.replace(/\n/g, '\n      ')}` : ''}`);
  }
  if (r.open_tasks_anyone_can_take.length) {
    out.push('--- open tasks (anyone) ---');
    for (const t of r.open_tasks_anyone_can_take) out.push(`  ${t.id} [${t.kind}] from ${t.from}: ${t.title}`);
  }
  out.push(`guidance: ${r.guidance}`);
  return out.join('\n');
}

function fmtMsg(m) {
  const to = m.to === 'everyone' ? '' : ` -> ${m.to}`;
  const att = m.attachments?.length ? `\n      attachments: ${m.attachments.map((a) => `${a.id} ${a.name} (${a.mime})${a.project_path ? ` at ${a.project_path}` : ''}`).join('; ')}` : '';
  return `#${m.seq} ${m.time.slice(11, 19)} ${m.from}${to}: ${m.text.replace(/\n/g, '\n      ')}${att}`;
}

async function startCommand(flags) {
  const { startServer } = await import('../src/server.js');
  const projectRoot = path.resolve(flags.project || process.cwd());
  const info = await startServer({
    projectRoot,
    name: flags.name,
    port: Number(flags.port || process.env.AIROOM_PORT || 7777),
    host: flags.host || '127.0.0.1',
    publicUrl: flags['public-url'],
    cliPath: CLI_PATH,
  });
  const show = () => {
    const l = info.links();
    console.log(`
AI Room "${info.room.s.name}" is running   (project: ${projectRoot})

  Dashboard (for you, the human):   ${l.dashboard}
  Invite link (paste to any AI):    ${l.invite}
  MCP connector URL:                ${l.mcp}
${l.public ? '' : `
  These links are local (this computer only). Desktop agents like Claude,
  Codex, Antigravity and Cursor can use them directly. ChatGPT / Claude.ai
  connectors are called from the cloud, so they need a public link:
  restart with --tunnel (needs cloudflared) or pass --public-url.
`}
Keep this running. Press Ctrl+C to stop.`);
  };

  if (flags.tunnel) {
    console.log('Starting a cloudflared quick tunnel...');
    const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${info.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', () => {
      console.log('cloudflared was not found. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or use --public-url with ngrok etc.');
      show();
    });
    let found = false;
    const scan = (chunk) => {
      const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !found) {
        found = true;
        info.setPublicUrl(m[0]);
        show();
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    process.on('exit', () => proc.kill());
  } else show();

  const stop = async () => {
    console.log('\nStopping room...');
    await info.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function linksCommand() {
  const dataDir = findDataDir();
  if (!dataDir) die('No room in this folder. Run `airoom start` first.');
  const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
  const room = JSON.parse(fs.readFileSync(path.join(dataDir, 'room.json'), 'utf8'));
  const base = `${s.url}/r/${room.code}`;
  console.log(`Dashboard:   ${base}/dashboard?key=${room.adminKey}\nInvite link: ${base}/join\nMCP URL:     ${base}/mcp`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || flags.help) return console.log(HELP);
  if (cmd === 'start') return startCommand(flags);
  if (cmd === 'links') return linksCommand();

  const conn = connection(flags);
  const text = pos.join(' ');

  if (cmd === 'join') {
    const name = flags.name || flags.as || pos[0];
    if (!name) die('Usage: airoom join --name <YourName> --app "<app>" [--caps a,b] [--lead]');
    const f = agentFile(conn.dataDir, name);
    const old = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).token : undefined;
    const r = await api(conn, 'join', { name, app: flags.app, model: flags.model, capabilities: flags.caps, lead: !!flags.lead, access: 'local' }, old);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ name, token: r.your_token }, null, 2));
    const agentName = r.welcome.match(/"([^"]+)"/)?.[1] || name;
    console.log(`${r.welcome} Role: ${r.role}. Lead: ${r.lead.name || 'none'}.`);
    console.log(`Brief: ${r.brief}`);
    console.log(`Members: ${r.members.map((m) => `${m.name}${m.role === 'lead' ? ' [lead]' : ''}${m.capabilities?.length ? ` (${m.capabilities.join(', ')})` : ''}`).join(', ')}`);
    console.log(`\nRules:\n${r.rules.map((x) => `- ${x}`).join('\n')}`);
    console.log(`\nYour identity is saved. Use --as ${agentName} on every command. Next: airoom wait --as ${agentName}`);
    return;
  }

  const token = tokenFor(flags, conn.dataDir);
  const call = (action, body) => api(conn, action, body, token);

  switch (cmd) {
    case 'wait': {
      const r = await call('wait', { timeout_seconds: Number(flags.timeout ?? 120), include_history: Number(flags.history || 0) });
      return flags.json ? print(r, flags) : console.log(formatWait(r));
    }
    case 'say':
    case 'send':
      if (!text) die('Nothing to say.');
      return print(await call('send', { text, to: flags.to, attachments: flags.attach }), flags);
    case 'ask':
      if (!text) die('Usage: airoom ask --to <member> "what you need"');
      return print(await call('ask', { title: text, to: flags.to, kind: flags.kind, details: flags.details, files: flags.files }), flags);
    case 'take':
      return print(await call('take_task', { task_id: pos[0] }), flags);
    case 'done':
    case 'finish':
      return print(await call('finish_task', { task_id: pos[0], result: pos.slice(1).join(' '), status: flags.status || 'done', attachments: flags.attach }), flags);
    case 'tasks':
      return print(await call('list_tasks', { include_done: !!flags.all }), flags);
    case 'status':
      return print(await call('status', {}), flags);
    case 'claim':
      return print(await call('claim_file', { path: pos[0], note: flags.note }), flags);
    case 'release':
      return print(await call('release_file', { path: pos[0] }), flags);
    case 'note':
      return print(await call('note', { text, kind: flags.decision ? 'decision' : 'note' }), flags);
    case 'notes':
      return print(await call('notes', {}), flags);
    case 'history': {
      const r = await call('read_messages', { limit: Number(flags.limit || 50) });
      return flags.json ? print(r, flags) : console.log(r.messages.map(fmtMsg).join('\n'));
    }
    case 'share': {
      const file = pos[0];
      if (!file) die('Usage: airoom share <file> [--to member] ["message"]');
      const abs = path.resolve(file);
      const root = conn.dataDir ? path.dirname(conn.dataDir) : process.cwd();
      const rel = path.relative(root, abs);
      const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
      const body = inside
        ? { path: rel, to: flags.to, message: pos.slice(1).join(' ') || undefined }
        : { base64: fs.readFileSync(abs).toString('base64'), name: path.basename(abs), to: flags.to, message: pos.slice(1).join(' ') || undefined };
      return print(await call('share_file', body), flags);
    }
    case 'save':
      return print(await call('save_asset', { asset_id: pos[0], path: pos[1] }), flags);
    case 'assets':
      return print(await call('list_assets', {}), flags);
    case 'activity':
      return print(await call('set_activity', { activity: text || undefined, status: flags.away ? 'away' : flags.back ? 'online' : undefined }), flags);
    case 'away':
      return print(await call('set_activity', { activity: text || undefined, status: 'away' }), flags);
    case 'back':
      return print(await call('set_activity', { status: 'online' }), flags);
    case 'brief':
      return print(await call('set_brief', { brief: text }), flags);
    case 'lead':
      return print(await call('set_lead', { name: pos[0] }), flags);
    case 'pause':
      return print(await call('pause', { paused: true, reason: text || undefined }), flags);
    case 'resume':
      return print(await call('pause', { paused: false }), flags);
    default:
      die(`Unknown command "${cmd}". Run: airoom help`);
  }
}

main().catch((err) => die(err.message));
