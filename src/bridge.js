// `crewroom mcp`: a stdio MCP server that apps launch locally (Claude desktop,
// Codex, Antigravity, Cursor, VS Code, Gemini CLI...). It forwards everything
// to the local hub's /mcp endpoint, starting the hub if needed, and reconnects
// transparently if the hub restarts.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ensureHub } from './client.js';
import { homeDir } from './util.js';

const REINIT_ID = '__crewroom_reinit__';
const REJOIN_ID = '__crewroom_rejoin__';
const log = (...a) => process.stderr.write(`[crewroom] ${a.join(' ')}\n`);

export async function runBridge({ home = homeDir() } = {}) {
  const stdio = new StdioServerTransport();
  let http = null;
  let initRequest = null;
  let initialized = false;
  let reconnecting = null;
  let token = null; // remembered from join_room, so a reconnect restores the member identity
  const joinIds = new Set();

  const connect = async () => {
    const info = await ensureHub({ home });
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`));
    t.onmessage = (m) => {
      if (m.id === REINIT_ID || m.id === REJOIN_ID) return;
      if (joinIds.has(m.id)) {
        joinIds.delete(m.id);
        try {
          token = JSON.parse(m.result?.content?.[0]?.text || '{}').your_token || token;
        } catch {}
      }
      stdio.send(m).catch(() => {});
    };
    t.onerror = (err) => log('connection:', err.message);
    await t.start();
    return t;
  };

  const reconnect = () => {
    reconnecting ||= (async () => {
      log('hub connection lost, reconnecting...');
      await http?.close().catch(() => {});
      http = await connect();
      if (initRequest) await http.send({ ...initRequest, id: REINIT_ID });
      if (initialized) await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (token) await http.send({ jsonrpc: '2.0', id: REJOIN_ID, method: 'tools/call', params: { name: 'join_room', arguments: { token, name: 'rejoin' } } });
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  };

  const forward = async (msg) => {
    if (isInitializeRequest(msg)) initRequest = msg;
    if (msg.method === 'tools/call' && msg.params?.name === 'join_room') joinIds.add(msg.id);
    if (msg.method === 'notifications/initialized') initialized = true;
    try {
      if (reconnecting) await reconnecting;
      await http.send(msg);
    } catch (err) {
      if (msg === initRequest) throw err;
      await reconnect();
      await http.send(msg);
    }
  };

  http = await connect();
  stdio.onmessage = (msg) => {
    forward(msg).catch((err) => {
      log('request failed:', err.message);
      if (msg.id !== undefined) {
        stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Crewroom hub unreachable: ${err.message}` } }).catch(() => {});
      }
    });
  };
  const quit = () => {
    http?.close().catch(() => {});
    process.exit(0);
  };
  stdio.onclose = quit;
  process.stdin.on('end', quit);
  await stdio.start();
}
