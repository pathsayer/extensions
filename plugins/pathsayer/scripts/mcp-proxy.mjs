#!/usr/bin/env node
// Pathsayer MCP PROXY (2026-09-15). The plugin's MCP entry, in every harness: the harness spawns
// this over stdio, and it forwards each JSON-RPC message to <origin>/local-mcp with the SAME
// credential the recon hooks present — the client token the signed-in Pathsayer tray wrote for
// this machine, or PATHSAYER_TOKEN (lib/hookauth.mjs, the ladder). No remote OAuth entry, so no
// browser tab ever opens for the plugin and no harness ever shows "needs authentication": signing
// in to the tray once arms the hooks AND the MCP tools.
//
// Laws:
//  - `initialize` is answered HERE, at once (the budget is under 100 ms; bare node is ~40 ms). The
//    server's surface is the app's known one — tools, and the canvas resource — so the answer is
//    static; the upstream is told when the first real message goes out.
//  - `tools/list` is forwarded and always succeeds, token or not (the door lets it through).
//  - a `tools/call` with NO token answers one plain line as a normal tool result — the same line
//    the mint hook shows the user — never an error, never a hang.
//  - the upstream is (re)established under the current token: the client's `initialize` replayed
//    with the bearer, then `notifications/initialized`; a token that appears or changes mid-session
//    (the tray signs in) re-establishes it. A session id the upstream issues is carried; the
//    stateless transport issues none.
//  - an SSE-framed answer is unwrapped into JSON-RPC lines; JSON answers pass through.
//  - a 401 on a forwarded message answers the plain line (a call) or an error (anything else) and
//    forgets the upstream so the next message re-establishes it — the proxy never deletes the
//    tray's file or the variable; a hook's cached bearer is the hooks' own business.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOrigin, peekBearer, detectHarness } from './lib/hookauth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The plugin's baked origin — generated at build (lib/origin.mjs); source-tree runs fall back to
 *  prod, which the rig's env pins override anyway. */
async function bakedOrigin() {
  try { return (await import('./lib/origin.mjs')).BAKED_ORIGIN; } catch { return 'https://pathsayer.com'; }
}
function pluginVersion() {
  try { return String(JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '0'); } catch { return '0'; }
}

/** The one line a person reads when nothing arms this machine — the mint hook's, word for word. */
export const NOT_SIGNED_IN =
  'Pathsayer: this machine is not signed in. Install and sign in to the Pathsayer tray, ' +
  'or set PATHSAYER_TOKEN from "Connect Cloud Device" on pathsayer.com/app.';

const DEFAULT_INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pathsayer-proxy', version: pluginVersion() } };

/** Parse an SSE body into its `data:` payloads (each one a JSON-RPC message). */
export function sseMessages(text) {
  const out = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* a keepalive or a partial — skip */ }
  }
  return out;
}

async function main() {
  const origin = resolveOrigin({ baked: await bakedOrigin() });
  const harness = detectHarness(process.env, {}).harness;
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const errorFor = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  let clientInit = null; // the client's initialize params — replayed upstream
  let upstream = null; // { token, sessionId } once established
  let establishing = null; // single-flight

  const headersFor = (tok, sessionId) => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(tok?.token ? { authorization: `Bearer ${tok.token}` } : {}), // the cloud rung (source remote) sends bare
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(harness ? { 'x-pathsayer-harness': harness } : {}),
    'x-pathsayer-plugin-version': pluginVersion(),
  });

  /** One upstream POST. Returns { status, messages, sessionId }. */
  async function post(msg, tok, sessionId, timeoutMs) {
    const res = await fetch(`${origin}/local-mcp`, {
      method: 'POST', headers: headersFor(tok, sessionId), body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id') ?? sessionId ?? null;
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text().catch(() => '');
    let messages = [];
    if (res.ok && text) {
      if (type.includes('text/event-stream')) messages = sseMessages(text);
      else { try { const p = JSON.parse(text); messages = Array.isArray(p) ? p : [p]; } catch { messages = []; } }
    }
    return { status: res.status, messages, sessionId: sid };
  }

  /** (Re)establish the upstream under `tok` — the replayed initialize, then initialized. */
  async function ensureUpstream(tok) {
    const key = tok?.token ?? null;
    if (upstream && upstream.token === key) return upstream;
    if (establishing) { await establishing; if (upstream && upstream.token === key) return upstream; }
    establishing = (async () => {
      const init = await post({ jsonrpc: '2.0', id: 'ps-init', method: 'initialize', params: clientInit ?? DEFAULT_INIT }, tok, null, 20_000);
      if (init.status === 401) throw Object.assign(new Error('unauthenticated'), { status: 401 });
      if (init.status >= 400) throw new Error(`Pathsayer is unreachable (initialize answered ${init.status})`);
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, tok, init.sessionId, 20_000).catch(() => undefined);
      upstream = { token: key, sessionId: init.sessionId };
    })();
    try { await establishing; } finally { establishing = null; }
    return upstream;
  }

  async function handle(msg) {
    if (Array.isArray(msg)) { for (const m of msg) await handle(m); return; }
    if (!msg || typeof msg !== 'object') return;
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (msg.method === 'initialize') {
      clientInit = msg.params ?? null;
      upstream = null; // a new client conversation — the upstream is told on the first real message
      write({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? DEFAULT_INIT.protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: 'pathsayer', version: pluginVersion() },
      } });
      return;
    }
    if (msg.method === 'notifications/initialized') return; // replayed when the upstream is established
    if (msg.method === 'ping' && isRequest) { write({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
    const tok = peekBearer({ origin });
    if (msg.method === 'tools/call' && !tok) {
      write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: NOT_SIGNED_IN }] } });
      return;
    }
    let up;
    try {
      up = await ensureUpstream(tok);
    } catch (e) {
      if (!isRequest) return;
      if (e?.status === 401) {
        if (msg.method === 'tools/call') write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: NOT_SIGNED_IN }] } });
        else write(errorFor(msg.id, -32001, NOT_SIGNED_IN));
        return;
      }
      write(errorFor(msg.id, -32603, e?.message ?? String(e)));
      return;
    }
    // a tool call may take seconds (a walk); the rest is sub-second — one generous budget
    const r = await post(msg, tok, up.sessionId, 120_000);
    if (!isRequest) return;
    if (r.status === 401) {
      upstream = null;
      if (msg.method === 'tools/call') write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: NOT_SIGNED_IN }] } });
      else write(errorFor(msg.id, -32001, NOT_SIGNED_IN));
      return;
    }
    if (r.status >= 400 || r.messages.length === 0) {
      write(errorFor(msg.id, -32603, `Pathsayer answered ${r.status}${r.messages.length === 0 ? ' with no message' : ''}`));
      return;
    }
    for (const m of r.messages) write(m);
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    handle(msg).catch((e) => {
      const id = Array.isArray(msg) ? null : msg?.id;
      if (id !== undefined && id !== null) write(errorFor(id, -32603, e?.message ?? String(e)));
    });
  });
  rl.on('close', () => { process.exitCode = 0; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { process.exitCode = 1; });
}
