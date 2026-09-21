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

import { resolveOrigin, peekBearer, heldSecrets, detectHarness, isCodexCloud } from './lib/hookauth.mjs';
import { maskExactString } from './lib/mask.mjs';
import { displayNameOf, rootOf } from './lib/checkout.mjs';

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

/** Codex's MCP client, by the name its `initialize` carries — the stripped environment it hands a
 *  stdio server names no harness (detectHarness reads nothing there). */
const CODEX_CLIENT = 'codex-mcp-client';
/** The capability a server declares to be told the session's directory, and the `_meta` key the
 *  answer rides on (Codex: `MCP_SANDBOX_STATE_META_CAPABILITY`). */
const SANDBOX_STATE = 'codex/sandbox-state-meta';

const DEFAULT_INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pathsayer-proxy', version: pluginVersion() } };

/** The message as it goes upstream: Codex's sandbox state is read HERE (the session's directory) and
 *  never forwarded — it is the person's permission profile and local paths, and the server has no use for it. */
export function withoutSandboxState(msg) {
  const meta = msg?.params?._meta;
  if (!meta || typeof meta !== 'object' || !(SANDBOX_STATE in meta)) return msg;
  const { [SANDBOX_STATE]: _dropped, ...rest } = meta;
  return { ...msg, params: { ...msg.params, _meta: rest } };
}

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
  let harness = detectHarness(process.env, {}).harness;
  // once, and LAZILY — on the first forwarded message, never before `initialize` is answered (its budget
  // is under 100 ms and the root costs a few git calls, O(history) the first time in a repo)
  // 2026-09-21 — a directory's PLACE: its root commit, or, when the checkout
  // withholds its root (a shallow clone), its display name (`org/repo` — from the origin remote, else
  // FETCH_HEAD, lib/checkout.mjs), which the door resolves by placement on the caller's device. The
  // display rides ONLY beside `none`: a known root is never second-guessed by a name.
  const placeOf = (dir) => { const root = rootOf(dir) ?? null; return { root, display: root === null ? (displayNameOf(dir) ?? null) : null }; };
  let placeMemo; const repoPlaceOnce = () => (placeMemo === undefined ? (placeMemo = placeOf(process.cwd())) : placeMemo);
  // 2026-09-19 — UNDER CODEX this process does NOT run in the session's directory. Codex expands no
  // placeholder in a plugin's MCP entry, so its entry (build.mjs CODEX_MCP_SERVER) starts the proxy
  // with `cwd` = the PLUGIN's folder — which in a cloud box can sit inside a clone of the marketplace
  // repo, so `process.cwd()` would name the WRONG repo, and the recon ops resolve their space by that
  // repo's placement. Codex says where the session is instead: a server that declares
  // `capabilities.experimental[SANDBOX_STATE]` gets `_meta[SANDBOX_STATE].sandboxCwd` (a file:// URI)
  // on every tools/call a model makes (witnessed, codex-cli 0.153.4). So under Codex the root is
  // THAT CALL's directory, per call; with none — a call made through the app-server directly carries
  // none — it is `none`, and the server asks for a `space_id`. It never reads process.cwd() here.
  let codex = false;
  const codexPlaces = new Map(); // directory → { root, display }, for the life of the process
  const NOWHERE = { root: null, display: null };
  const codexPlaceOf = (msg) => {
    const raw = msg?.params?._meta?.[SANDBOX_STATE]?.sandboxCwd;
    if (typeof raw !== 'string' || !raw) return NOWHERE;
    let dir = raw;
    if (raw.startsWith('file:')) { try { dir = fileURLToPath(raw); } catch { return NOWHERE; } }
    if (!codexPlaces.has(dir)) codexPlaces.set(dir, placeOf(dir));
    return codexPlaces.get(dir);
  };
  const placeFor = (msg) => (codex ? codexPlaceOf(msg) : repoPlaceOnce());
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const errorFor = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  let clientInit = null; // the client's initialize params — replayed upstream
  let upstream = null; // { token, sessionId } once established
  let establishing = null; // single-flight

  const headersFor = (tok, sessionId, place) => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(tok?.token ? { authorization: `Bearer ${tok.token}` } : {}), // the cloud rung (source remote) sends bare
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(harness ? { 'x-pathsayer-harness': harness } : {}),
    'x-pathsayer-plugin-version': pluginVersion(),
    // 2026-09-18 — WHICH REPO the call came from: the root commit of the directory the harness
    // started this proxy in — under Codex, of the directory the CALL came from (rootFor, above) — (the
    // hooks' own anchor rule — lib/checkout.mjs; null outside a repo and
    // under a shallow clone, and then it says `none`). The recon ops resolve their space by that
    // repo's PLACEMENT; with no root the server asks for a `space_id` — it never guesses one, since
    // what recon returns becomes part of this session's transcript.
    'x-pathsayer-repo-root': place.root ?? 'none', // ALWAYS present from this release on: its presence is how the server tells a current proxy (strict — no fallback) from one that predates it (keeps the looser fallback)
    // 2026-09-21 — beside `none`, the repo's NAME when the checkout has one (a shallow
    // clone's org/repo): the door resolves it by placement on the caller's own device, or refuses as before
    ...(place.root === null && place.display ? { 'x-pathsayer-repo-display': place.display } : {}),
  });

  /** One upstream POST. Returns { status, messages, sessionId }. */
  async function post(msg, tok, sessionId, timeoutMs) {
    const res = await fetch(`${origin}/local-mcp`, {
      // the mask (2026-09-17): the model's own arguments go out as ONE serialized body, masked; the bearer header never is
      method: 'POST', headers: headersFor(tok, sessionId, placeFor(msg)), body: maskExactString(JSON.stringify(withoutSandboxState(msg)), heldSecrets({ origin })), signal: AbortSignal.timeout(timeoutMs),
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
      codex = msg.params?.clientInfo?.name === CODEX_CLIENT;
      // an explicit PATHSAYER_HARNESS (forwarded by the Codex entry) still wins; else Codex — and Codex
      // Cloud when the entry forwarded the cloud's originator (2026-09-21)
      if (codex && !harness) harness = isCodexCloud(process.env) ? 'codex-cloud' : 'codex';
      write({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? DEFAULT_INIT.protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, ...(codex ? { experimental: { [SANDBOX_STATE]: {} } } : {}) },
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
