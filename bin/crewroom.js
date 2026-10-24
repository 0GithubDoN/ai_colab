#!/usr/bin/env node
// crewroom: a room where AI assistants from different apps work on one project together.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { homeDir, readJson, writeJson, normalizeCode, openInBrowser, VERSION, CLI_PATH } from '../src/util.js';
import { ensureHub, runningHub, hubApi, findProjectRoot } from '../src/client.js';

const BOOLEAN_FLAGS = new Set(['lead', 'all', 'json', 'decision', 'away', 'back', 'public', 'open', 'yes', 'y', 'list', 'off', 'new-code', 'help', 'h', 'remove']);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const [k, inline] = a.replace(/^--?/, '').split(/=(.*)/s);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const HELP = `crewroom ${VERSION}: one room, all your AIs, one project.

SET UP (once per computer)
  crewroom connect              add Crewroom to your installed AI apps
                                (Claude desktop, Claude Code, Codex, Antigravity, Cursor,
                                 Windsurf, VS Code, Gemini CLI). --list shows status.
  crewroom disconnect           remove it again

START A ROOM (in your project folder)
  crewroom start [--name "My App"] [--open] [--public]
                                prints the dashboard link (for you) and the invite
                                link/code (for your AIs). Runs in the background.
  crewroom open                 open the dashboard in your browser
  crewroom links                show the links again
  crewroom public [--off]       public link for cloud AIs (ChatGPT, Claude.ai web)
  crewroom stop [--all]         close this project's room (--all: stop Crewroom)
  crewroom start --new-code     new room code, everyone removed (if a link leaked)
  crewroom doctor               check that everything works

FOR AI AGENTS WITH A TERMINAL (run in the project folder)
  crewroom join --name Claude --app "Claude Code" --caps "terminal,local-files" [--lead]
  crewroom wait --as Claude [--timeout 90]
  crewroom say --as Claude [--to Gemini] "message"
  crewroom ask --as Claude [--to ChatGPT] [--kind task|review|fix|question|asset|research]
               [--details "..."] [--files a.js,b.js] "title"
  crewroom take --as Gemini T2           crewroom done --as Gemini T2 "result" [--status blocked] [--attach id]
  crewroom claim --as Claude src/app.js  crewroom release --as Claude src/app.js
  crewroom share --as Gemini icon.png [--to Claude] ["message"]
  crewroom save --as Claude <fileId> public/icon.png
  crewroom status | tasks | history | assets | notes | changes  --as Claude
  crewroom note --as Claude [--decision] "text"
  crewroom away --as Claude ["reason"]   crewroom back --as Claude
  crewroom brief | lead <Name> | pause | resume  --as Claude      (lead only)
  Options: --as <Name> (saved by join), --token, --url <invite link> to use another room.

ADVANCED
  crewroom hub [--port 7777] [--host 127.0.0.1] [--public-url URL]   run the hub in the foreground
  crewroom mcp                  stdio MCP server (what apps launch; set up by "connect")
`;

function die(msg) {
  console.error(`crewroom: ${msg}`);
  process.exit(1);
}

// ---------------- room connection for agent commands ----------------

async function roomConnection(flags) {
  const invite = flags.url || process.env.CREWROOM_URL;
  if (invite) {
    const m = String(invite).match(/^(https?:\/\/[^/]+)\/r\/([^/]+)/);
    if (!m) die('--url must be an invite link like http://127.0.0.1:7777/r/ABCD-EFGH-JKLM/join');
    return { base: `${m[1]}/r/${normalizeCode(m[2])}`, code: normalizeCode(m[2]) };
  }
  const root = findProjectRoot();
  if (!root) die('No room in this folder. Run "crewroom start" here first, or pass --url <invite link>.');
  const hub = await ensureHub();
  const links = await hubApi(hub, 'rooms', { projectRoot: root });
  return { base: `http://127.0.0.1:${hub.port}/r/${links.code}`, code: links.code, root, hub, links };
}

const identityFile = (code, name) => path.join(homeDir(), 'agents', code, `${String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}.json`);

function tokenFor(flags, conn) {
  if (flags.token) return flags.token;
  const name = flags.as || process.env.CREWROOM_AS;
  if (name) {
    const saved = readJson(identityFile(conn.code, name));
    if (!saved) die(`No saved identity for "${name}" in this room. Run: crewroom join --name ${name} --app "<your app>"`);
    return saved.token;
  }
  if (process.env.CREWROOM_TOKEN) return process.env.CREWROOM_TOKEN;
  die('Who are you? Add --as <YourName> (the name you joined with).');
}

async function api(conn, action, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${conn.base}/api/${action}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  } catch (err) {
    die(`Cannot reach the room (${err.cause?.code || err.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------- output ----------------

function fmtMsg(m) {
  const to = m.to === 'everyone' ? '' : ` -> ${m.to}`;
  const att = m.attachments?.length ? `\n      files: ${m.attachments.map((a) => `${a.id} ${a.name} (${a.mime})${a.project_path ? ` at ${a.project_path}` : ''}`).join('; ')}` : '';
  return `#${m.seq} ${m.time.slice(11, 19)} ${m.from}${to}${m.mentions_you ? ' [mentions you]' : ''}: ${m.text.replace(/\n/g, '\n      ')}${att}`;
}

function fmtTask(t) {
  return `  ${t.id} [${t.kind}, ${t.status}] from ${t.from}${t.assigned_to !== 'anyone' ? ` to ${t.assigned_to}` : ''}: ${t.title}${t.details ? `\n      ${t.details.replace(/\n/g, '\n      ')}` : ''}${t.files ? `\n      files: ${t.files.join(', ')}` : ''}`;
}

function formatWait(r) {
  const out = [`lead: ${r.lead?.name ? `${r.lead.name} (${r.lead.status})` : 'none'}${r.paused ? '  |  ROOM PAUSED' : ''}`];
  if (r.history?.length) out.push('--- earlier ---', ...r.history.map(fmtMsg));
  out.push(r.new_messages.length ? `--- ${r.new_messages.length} new message(s) ---` : '--- no new messages ---', ...r.new_messages.map(fmtMsg));
  if (r.your_tasks.length) out.push('--- your tasks ---', ...r.your_tasks.map(fmtTask));
  if (r.open_tasks_anyone_can_take.length) out.push('--- open tasks anyone can take ---', ...r.open_tasks_anyone_can_take.map(fmtTask));
  out.push(`guidance: ${r.guidance}`);
  return out.join('\n');
}

function printLinks(l, { header = true } = {}) {
  if (header) console.log(`\nCrewroom is ready: "${l.name}"   (${l.project})\n`);
  console.log(`  Dashboard (only for you):   ${l.dashboard}`);
  console.log(`  Invite link for your AIs:   ${l.invite}`);
  console.log(`  Room code:                  ${l.code}`);
  if (l.public_mcp) {
    console.log(`\n  Public link (for ChatGPT / Claude.ai web connectors):`);
    console.log(`  MCP URL:                    ${l.public_mcp}`);
    console.log(`  Public invite page:         ${l.public_invite}`);
  } else if (l.tunnel?.state === 'error') {
    console.log(`\n  Public link failed: ${l.tunnel.error}`);
  }
}

function nextSteps(l) {
  console.log(`
Next:
  • Paste the invite link (or just the code ${l.code}) into any AI app and say "join this room".
  • AI apps not set up yet? Run once:  crewroom connect
  • ChatGPT or Claude.ai on the web?  Run:  crewroom public   (or use the button on the dashboard)
Crewroom keeps running in the background. "crewroom stop" closes this room.`);
}

// ---------------- commands ----------------

async function cmdStart(flags) {
  const root = path.resolve(flags.project || process.cwd());
  const hub = await ensureHub({ port: flags.port ? Number(flags.port) : undefined });
  let links = await hubApi(hub, 'rooms', { projectRoot: root, name: flags.name, resetAccess: !!flags['new-code'] });
  if (flags.public) {
    console.log('Starting the public link (first time downloads cloudflared, ~20 MB)...');
    const t = await hubApi(hub, 'tunnel', { on: true });
    links = t.rooms.find((r) => r.code === links.code) || links;
  }
  if (flags.json) return console.log(JSON.stringify(links, null, 2));
  printLinks(links);
  nextSteps(links);
  if (flags.open) openInBrowser(links.dashboard);
}

async function cmdLinks(flags, { open = false } = {}) {
  const root = findProjectRoot();
  if (!root) die('No room in this folder. Run "crewroom start" first.');
  const hub = await ensureHub();
  const links = await hubApi(hub, 'rooms', { projectRoot: root });
  if (open) {
    openInBrowser(links.dashboard);
    return console.log(`Opening ${links.dashboard}`);
  }
  if (flags.json) return console.log(JSON.stringify(links, null, 2));
  printLinks(links, { header: false });
}

async function cmdPublic(flags) {
  const hub = await ensureHub();
  if (!flags.off) console.log('Starting the public link (first time downloads cloudflared, ~20 MB)...');
  const t = await hubApi(hub, 'tunnel', { on: !flags.off });
  if (flags.off) return console.log('Public link is off. Only apps on this computer can reach your rooms.');
  if (t.state !== 'on' && t.state !== 'custom') die(`Could not start the public link: ${t.error}`);
  const root = findProjectRoot();
  const rooms = root ? t.rooms.filter((r) => r.project === root) : t.rooms;
  for (const r of rooms) {
    console.log(`\n"${r.name}"  MCP URL: ${r.public_mcp}`);
  }
  console.log(`
Add the MCP URL as a connector:
  ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode on → Create → paste the URL (no auth).
  Claude.ai: Settings → Connectors → Add custom connector → paste the URL.
Then say "join the Crewroom room ${rooms[0]?.code || ''}".
The link changes each time the public link restarts. Turn it off with: crewroom public --off`);
}

async function cmdStop(flags) {
  const hub = await runningHub();
  if (!hub) return console.log('Crewroom is not running.');
  if (flags.all) {
    await hubApi(hub, 'shutdown', {});
    return console.log('Crewroom stopped.');
  }
  const root = findProjectRoot();
  if (!root) die('No room in this folder. Use --all to stop Crewroom completely.');
  await hubApi(hub, 'rooms/close', { projectRoot: root }).catch((e) => die(e.message));
  console.log('Room closed. Its history is kept in .crewroom/; "crewroom start" reopens it.');
}

async function cmdHub(flags) {
  const { Hub } = await import('../src/hub.js');
  const hub = new Hub({ port: flags.port !== undefined ? Number(flags.port) : Number(process.env.CREWROOM_PORT || 7777), host: flags.host || '127.0.0.1', publicUrl: flags['public-url'] });
  try {
    await hub.start();
  } catch (err) {
    if (err.code === 'HUB_RUNNING') {
      console.log(err.message);
      process.exit(0);
    }
    throw err;
  }
  if (flags.public) hub.setTunnel(true);
  const stop = () => hub.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdConnect(pos, flags, { remove = false } = {}) {
  const { APPS, appStatus, configureApp } = await import('../src/connect.js');
  const status = appStatus();
  if (flags.list) {
    console.log('App                                   Installed  Crewroom');
    for (const s of status) console.log(`${s.app.label.padEnd(38)}${(s.installed ? 'yes' : 'no').padEnd(11)}${s.configured === null ? '?' : s.configured ? 'connected' : '-'}`);
    return;
  }
  let targets;
  if (pos.length) {
    targets = pos.map((id) => APPS.find((a) => a.id === id) || die(`Unknown app "${id}". Known: ${APPS.map((a) => a.id).join(', ')}`));
  } else {
    targets = status.filter((s) => s.installed && (remove ? s.configured !== false : true)).map((s) => s.app);
    if (!targets.length) {
      console.log(remove ? 'Crewroom is not set up in any app.' : 'No supported AI apps found on this computer.');
      if (!remove) console.log(`You can still use Crewroom from any agent with a terminal (see "crewroom help"),\nor add this MCP server by hand in your app:\n  command: ${process.execPath}\n  args:    ${CLI_PATH} mcp`);
      return;
    }
    console.log(`${remove ? 'Remove Crewroom from' : 'Set up Crewroom in'}:\n${targets.map((a) => `  • ${a.label}`).join('\n')}`);
    if (process.stdin.isTTY && !flags.yes && !flags.y) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Continue? [Y/n] ')).trim().toLowerCase();
      rl.close();
      if (answer && !answer.startsWith('y')) return console.log('Nothing changed.');
    }
  }
  const afters = [];
  for (const app of targets) {
    for (const r of configureApp(app, { remove })) console.log(`${r.ok ? '✓' : '✗'} ${app.label}: ${r.message}`);
    if (!remove && app.after) afters.push(`  • ${app.label}: ${app.after}`);
  }
  if (remove) return;
  console.log(`\nAlmost done. Restart the apps so they load Crewroom:\n${afters.join('\n')}`);
  console.log(`
Then in any of them: start a room ("crewroom start" in your project, or ask your AI to),
paste the invite link or code into the chat, and say "join this room".

ChatGPT and Claude.ai (web) run in the cloud and cannot start programs on your PC.
For them run "crewroom public" and add the MCP URL it prints as a connector.`);
}

async function cmdDoctor() {
  const ok = (b, msg) => console.log(`${b ? '✓' : '✗'} ${msg}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 20, `Node.js ${process.versions.node}${major >= 20 ? '' : ' (need 20 or newer)'}`);
  ok(true, `Crewroom ${VERSION} at ${CLI_PATH}`);
  if (/_npx[\\/]/.test(CLI_PATH)) console.log('  ! Running from a temporary npx folder. Install globally so app configs keep working: npm i -g crewroom');
  let hub = await runningHub();
  ok(!!hub, hub ? `hub running on http://127.0.0.1:${hub.port} (pid ${hub.pid})` : 'hub not running (it starts automatically when needed)');
  if (!hub) {
    try {
      hub = await ensureHub();
      ok(true, `hub started on port ${hub.port}`);
    } catch (err) {
      ok(false, err.message);
    }
  }
  if (hub) {
    const { rooms } = await hubApi(hub, 'rooms', null, 'GET');
    ok(true, `${rooms.length} open room(s)${rooms.length ? `: ${rooms.map((r) => `${r.name} (${r.code})`).join(', ')}` : ''}`);
  }
  const root = findProjectRoot();
  console.log(root ? `  this folder belongs to the room in ${root}` : '  no room in this folder (run "crewroom start" here)');
  const { appStatus } = await import('../src/connect.js');
  for (const s of appStatus()) if (s.installed) ok(s.configured !== false, `${s.app.label}: ${s.configured === null ? 'installed (run "crewroom connect claude-code" to be sure)' : s.configured ? 'connected' : 'not connected (run "crewroom connect")'}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  if (!cmd || ['help', '--help', '-h'].includes(cmd) || flags.help) return console.log(HELP);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') return console.log(VERSION);

  switch (cmd) {
    case 'start': return cmdStart(flags);
    case 'links': return cmdLinks(flags);
    case 'open': return cmdLinks(flags, { open: true });
    case 'public': return cmdPublic(flags);
    case 'stop': return cmdStop(flags);
    case 'hub': return cmdHub(flags);
    case 'mcp': {
      const { runBridge } = await import('../src/bridge.js');
      return runBridge();
    }
    case 'connect':
    case 'setup': return cmdConnect(pos, flags);
    case 'disconnect': return cmdConnect(pos, flags, { remove: true });
    case 'doctor': return cmdDoctor();
  }

  // ---- agent commands ----
  const conn = await roomConnection(flags);
  const text = pos.join(' ');

  if (cmd === 'join') {
    const name = flags.name || flags.as || pos[0];
    if (!name) die('Usage: crewroom join --name <YourName> --app "<your app>" [--caps a,b] [--lead]');
    const file = identityFile(conn.code, name);
    const old = readJson(file)?.token;
    const r = await api(conn, 'join', { name, app: flags.app, model: flags.model, capabilities: flags.caps, lead: !!flags.lead }, old);
    const joinedAs = r.welcome.match(/"([^"]+)"/)?.[1] || name;
    writeJson(identityFile(conn.code, joinedAs), { name: joinedAs, token: r.your_token }, { mode: 0o600 });
    console.log(`${r.welcome} Role: ${r.role}. Lead: ${r.lead.name || 'nobody yet'}.`);
    console.log(`Project folder: ${r.project_folder}`);
    console.log(`Brief: ${r.brief}`);
    console.log(`Members: ${r.members.map((m) => `${m.name}${m.role === 'lead' ? ' [lead]' : ''} (${m.app}${m.capabilities?.length ? `; ${m.capabilities.join(', ')}` : ''})`).join(', ')}`);
    console.log(`\nRules:\n${r.rules.map((x) => `- ${x}`).join('\n')}`);
    console.log(`\nSaved your identity. Add --as ${joinedAs} to every command.`);
    console.log(`Next: crewroom say --as ${joinedAs} "hi, I'm ${joinedAs}; I can ..."   then   crewroom wait --as ${joinedAs}`);
    return;
  }

  const token = tokenFor(flags, conn);
  const call = (action, body) => api(conn, action, body, token);
  const out = (r) => console.log(flags.json ? JSON.stringify(r, null, 2) : typeof r === 'string' ? r : JSON.stringify(r, null, 2));

  switch (cmd) {
    case 'wait': {
      let remaining = Number(flags.timeout ?? 90);
      let r;
      do {
        const chunk = Math.min(remaining, 280);
        r = await call('wait', { timeout_seconds: chunk, include_history: Number(flags.history || 0) });
        remaining -= chunk;
      } while (!r.new_messages.length && remaining > 0);
      return flags.json ? out(r) : console.log(formatWait(r));
    }
    case 'say':
    case 'send':
      if (!text) die('Nothing to say.');
      return out(await call('send', { text, to: flags.to, attachments: flags.attach }));
    case 'ask':
      if (!text) die('Usage: crewroom ask --to <member> "what you need"');
      return out(await call('ask', { title: text, to: flags.to, kind: flags.kind, details: flags.details, files: flags.files }));
    case 'take':
      return out(await call('take_task', { task_id: pos[0] }));
    case 'done':
    case 'finish':
      return out(await call('finish_task', { task_id: pos[0], result: pos.slice(1).join(' '), status: flags.status || 'done', attachments: flags.attach }));
    case 'tasks': {
      const r = await call('list_tasks', { include_done: !!flags.all });
      return flags.json ? out(r) : console.log(r.tasks.length ? r.tasks.map((t) => `${fmtTask(t)}${t.result ? `\n      result: ${t.result.replace(/\n/g, '\n      ')}` : ''}`).join('\n') : 'No tasks.');
    }
    case 'status':
      return out(await call('status', {}));
    case 'claim':
      return out(await call('claim_file', { path: pos[0], note: flags.note }));
    case 'release':
      return out(await call('release_file', { path: pos[0] }));
    case 'note':
      return out(await call('note', { text, kind: flags.decision ? 'decision' : 'note' }));
    case 'notes':
      return out(await call('notes', {}));
    case 'changes': {
      const r = await call('project_changes', { path: pos[0] });
      return flags.json || !r.git ? out(r) : console.log(`${r.status}\n\n${r.summary}\n\n${r.diff}`);
    }
    case 'history': {
      const r = await call('read_messages', { limit: Number(flags.limit || 50) });
      return flags.json ? out(r) : console.log(r.messages.map(fmtMsg).join('\n'));
    }
    case 'share': {
      const file = pos[0];
      if (!file) die('Usage: crewroom share <file> [--to member] ["message"]');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) die(`${file} not found.`);
      const message = pos.slice(1).join(' ') || undefined;
      const rel = conn.root ? path.relative(conn.root, abs) : null;
      const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith('.crewroom');
      const body = inside ? { path: rel, to: flags.to, message } : { base64: fs.readFileSync(abs).toString('base64'), name: path.basename(abs), to: flags.to, message };
      return out(await call('share_file', body));
    }
    case 'save':
      return out(await call('save_asset', { asset_id: pos[0], path: pos[1] }));
    case 'assets':
      return out(await call('list_assets', {}));
    case 'activity':
      return out(await call('set_activity', { activity: pos.length ? text : undefined, status: flags.away ? 'away' : flags.back ? 'online' : undefined }));
    case 'away':
      return out(await call('set_activity', { activity: text || undefined, status: 'away' }));
    case 'back':
      return out(await call('set_activity', { status: 'online' }));
    case 'brief':
      return out(await call('set_brief', { brief: text }));
    case 'lead':
      return out(await call('set_lead', { name: pos[0] }));
    case 'pause':
      return out(await call('pause', { paused: true, reason: text || undefined }));
    case 'resume':
      return out(await call('pause', { paused: false }));
    default:
      die(`Unknown command "${cmd}". Run: crewroom help`);
  }
}

main().catch((err) => die(err.message));
