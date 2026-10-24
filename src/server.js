// HTTP server: REST API (for agents with a terminal), MCP endpoint (for apps
// with connectors), live dashboard (for the human) and the invite page.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Room, RoomError, HUMAN_ID } from './room.js';
import { createMcpServer } from './mcp.js';
import { inviteText } from './invite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.join(here, '..', 'public', 'dashboard.html');
const MAX_BODY = 40 * 1024 * 1024;

export function startServer({ projectRoot, name, port = 7777, host = '127.0.0.1', publicUrl, cliPath, quiet = false } = {}) {
  const room = new Room({ projectRoot, name });
  const sessions = new Map(); // mcp-session-id -> { transport, server, ctx }
  const state = { publicUrl: publicUrl ? publicUrl.replace(/\/+$/, '') : null };

  const baseUrlFor = (req) => {
    if (state.publicUrl) return state.publicUrl;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  };

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof RoomError ? err.status : 500;
      if (status === 500 && !quiet) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/' || url.pathname === '/health') {
      return sendText(res, 200, 'AI Room is running. Use the links printed in the terminal (or ask the lead for them).\n');
    }
    if (parts[0] !== 'r' || parts[1] !== room.code) throw new RoomError('Unknown room.', 404);
    const sub = parts.slice(2);
    const base = `${baseUrlFor(req)}/r/${room.code}`;

    // --- invite page (plain text written for AIs) ---
    if (sub.length === 0 || sub[0] === 'join') {
      return sendText(res, 200, inviteText(room, { base, cliPath }));
    }

    // --- dashboard ---
    if (sub[0] === 'dashboard') {
      if (url.searchParams.get('key') !== room.adminKey) return sendText(res, 403, 'Wrong or missing dashboard key. Use the dashboard link printed by `airoom start`.\n');
      const html = fs.readFileSync(DASHBOARD, 'utf8').replace('__ROOM_CODE__', room.code);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (sub[0] === 'events') {
      if (url.searchParams.get('key') !== room.adminKey) throw new RoomError('Forbidden', 403);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const push = () => res.write(`data: ${JSON.stringify({ ...room.snapshot(), links: links(room, base, state) })}\n\n`);
      let timer = null;
      const onChange = () => { if (!timer) timer = setTimeout(() => { timer = null; push(); }, 120); };
      push();
      room.on('change', onChange);
      const ping = setInterval(() => { res.write(': ping\n\n'); onChange(); }, 15000);
      req.on('close', () => { room.off('change', onChange); clearInterval(ping); clearTimeout(timer); });
      return;
    }

    // --- assets ---
    if (sub[0] === 'assets' && sub[1] && req.method === 'GET') {
      const a = room.assetFile(sub[1]);
      if (!a || !fs.existsSync(a.file)) throw new RoomError('No such asset.', 404);
      res.writeHead(200, { 'content-type': a.mime, 'content-length': fs.statSync(a.file).size, 'content-disposition': `inline; filename="${a.name}"` });
      return fs.createReadStream(a.file).pipe(res);
    }

    if (sub[0] === 'upload' && req.method === 'POST') {
      if (req.headers['x-admin-key'] !== room.adminKey) throw new RoomError('Forbidden', 403);
      const buffer = await readBody(req);
      const name = url.searchParams.get('name') || 'upload';
      const result = await room.call('share_file', { id: HUMAN_ID }, { base64: buffer.toString('base64'), name, mime: req.headers['content-type'], message: url.searchParams.get('message') || `Human shared ${name}`, to: url.searchParams.get('to') || undefined });
      return sendJson(res, 200, result);
    }

    // --- REST API: POST /r/<code>/api/<action> ---
    if (sub[0] === 'api' && sub[1]) {
      if (req.method !== 'POST') throw new RoomError('Use POST with a JSON body.', 405);
      const raw = await readBody(req);
      let args = {};
      if (raw.length) {
        try { args = JSON.parse(raw.toString('utf8')); } catch { throw new RoomError('Body must be JSON.'); }
      }
      const action = sub[1];
      let actor = null;
      if (req.headers['x-admin-key']) {
        if (req.headers['x-admin-key'] !== room.adminKey) throw new RoomError('Wrong admin key.', 403);
        actor = { id: HUMAN_ID };
      }
      const auth = req.headers.authorization || '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : args.token;
      delete args.token;
      if (action === 'join') {
        return sendJson(res, 200, await room.call('join', null, { access: 'local', ...args, token: tok }));
      }
      actor = actor || room.memberByToken(tok);
      if (!actor) throw new RoomError('Missing or unknown token. Join first.', 401);
      return sendJson(res, 200, await room.call(action, actor, args));
    }

    // --- MCP (Streamable HTTP) ---
    if (sub[0] === 'mcp') return handleMcp(req, res);

    throw new RoomError('Not found.', 404);
  }

  async function handleMcp(req, res) {
    const sid = req.headers['mcp-session-id'];
    let body;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined; } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    }

    if (sid && sessions.has(sid)) {
      return sessions.get(sid).transport.handleRequest(req, res, body);
    }
    if (sid && !sessions.has(sid)) {
      // Spec: unknown session -> 404 so the client re-initializes.
      return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    }

    const initializing = req.method === 'POST' && (Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body));
    const ctx = { memberId: null };
    const mcp = createMcpServer(room, ctx);
    let transport;
    if (initializing) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => sessions.set(id, { transport, server: mcp, ctx }),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    } else {
      // Clients that do not keep sessions: serve the request statelessly (tools accept `token`).
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); mcp.close(); });
    }
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const localBase = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
      const info = {
        room,
        server,
        port: actualPort,
        localBase,
        setPublicUrl: (u) => { state.publicUrl = u ? u.replace(/\/+$/, '') : null; room.emit('change', 'links'); },
        links: () => links(room, `${state.publicUrl || localBase}/r/${room.code}`, state, localBase),
        close: () => new Promise((r) => { room.flush(); for (const s of sessions.values()) s.transport.close(); server.closeAllConnections?.(); server.close(() => r()); }),
      };
      writeServerFile(room, info);
      resolve(info);
    });
  });
}

function links(room, base, state, localBase) {
  const local = localBase ? `${localBase}/r/${room.code}` : base;
  return {
    invite: `${base}/join`,
    mcp: `${base}/mcp`,
    dashboard: `${local}/dashboard?key=${room.adminKey}`,
    public: !!state.publicUrl,
  };
}

function writeServerFile(room, info) {
  // Lets the CLI find the running room from the project folder.
  fs.writeFileSync(path.join(room.dataDir, 'server.json'), JSON.stringify({ url: info.localBase, code: room.code, pid: process.pid }, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new RoomError('Body too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
