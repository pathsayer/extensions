#!/usr/bin/env node
// Pathsayer cloud COURIER (2026-09-15) — runs on Stop (every turn) and SessionEnd (the tail)
// and ships this environment's transcripts to the client-token ingest door. It runs ONLY in a
// remote harness (Claude Code Cloud: CLAUDE_CODE_ENTRYPOINT=remote / CLAUDE_CODE_REMOTE — or
// PATHSAYER_SHIP=1, the laptop proof's pin) with a credential by the ladder; on a laptop the tray
// captures, and this script ships nothing.
//
// Shape (the July courier's, rebuilt on today's auth and the facts wire):
//   discover   every *.jsonl under $HOME/.claude/projects (PATHSAYER_PROJECTS_DIR overrides) — the
//              main session AND subagent transcripts; session_id = the file stem. The payload's
//              transcript_path names the main session only: never the discovery mechanism.
//              *.jsonl ONLY (never .meta.json / tool-results siblings). A partial trailing line is
//              held: the frontier is the newline-aligned EOF.
//   declare    POST /local-ingest/reconcile on the FACTS wire (protocol 4): one declaration per
//              session — {session_id, harness, anchor, byte_hwm, generation, prefix_sha,
//              origin_byte 0}, `full: false` (an upsert of what this VM holds; never `full` — a
//              second VM on the same token holds other sessions the server must not prune). The
//              cursor is server-held: the answer's `needs` say what to ship, from where.
//   ship       PUT /local-ingest/chunk per need: gzip of the aligned slice, the envelope in the
//              x-pathsayer-ingest header (protocol 2), content_sha256 over the raw bytes;
//              ok → advance · gap → resend from the server's hwm · resync → adopt the generation,
//              re-declare, re-ship from 0.
//   anchor     `repo:<root commit>` from the session's cwd (lib/checkout.mjs — the same helper the
//              fires use, so a cloud session lands in the repo's existing stream); else
//              `folder:<cwd>`. The checkout root rides the envelope (the record relativizes paths by it).
//   consent    the server's: a session on a repo not enabled on this cloud device is refused
//              (`not_consented`) and never stored — the courier logs it and moves on.
//   never blocks the harness: every outcome is exit 0; every failure is one stderr line. A 401
//   says the token was refused (the device was removed on Home, or the token is wrong) and drops
//   NOTHING — the credential is the environment's, not this script's.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOrigin, peekBearer, heldSecrets, detectHarness, isRemoteHarness } from './lib/hookauth.mjs';
import { displayNameOf, rootStateOf, toplevelOf } from './lib/checkout.mjs';
import { maskExact } from './lib/mask.mjs';

const PROTOCOL_VERSION = 2;
const RECONCILE_PROTOCOL_FACTS = 4;
const PREFIX_PROBE_BYTES = 4096;
/** The tray's page (crawler sync.rs MAX_CHUNK_BYTES): a delta ships in pages of at most this, so
 *  the server's 24 MiB decompressed cap is never reached by a long-lived session's backlog. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** Claude Code Cloud is its OWN harness (2026-09-15): a repo's cloud sessions are their own
 *  substream, shared from the cloud device's card; the server reads the files as Claude Code's.
 *  Renamed from `claude-code-web` on 2026-09-18 (R10) so the two cloud harnesses rhyme.
 *  THIS VALUE SHIPS AFTER THE SERVER, never before: a server without R10's frozen id recipe would
 *  read the new name as a new substream and fork the person's repo off its history. */
const CLOUD_HARNESS = 'claude-code-cloud';
/** The tray reads a transcript's cwd from its HEAD only (crawler projects.rs read_head_cwd). */
const HEAD_BYTES = 64 * 1024;
const MAX_ROUNDS = 4; // declare → ship → confirm (a resync re-declares once more)
const MAX_CHUNK_ITERS = 64; // per-session backstop against a pathological gap/resync loop
const FETCH_TIMEOUT_MS = 20_000;

/** The plugin's baked origin (build-generated); source-tree runs (the rig) fall back to prod,
 *  which the rig's PATHSAYER_ORIGIN pin overrides anyway. */
async function bakedOrigin() {
  try { return (await import('./lib/origin.mjs')).BAKED_ORIGIN; } catch { return 'https://pathsayer.com'; }
}
async function pluginVersion() {
  try {
    const pj = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin/plugin.json'), 'utf8'));
    return typeof pj.version === 'string' ? pj.version : '0.0.0';
  } catch { return '0.0.0'; }
}

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
const say = (line) => process.stderr.write(`Pathsayer: ${line}\n`);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** Newline-aligned EOF — the declared frontier; a partial trailing line is HELD. */
function alignedEof(buf) {
  const nl = buf.lastIndexOf(0x0a);
  return nl < 0 ? 0 : nl + 1;
}

/** sha256 of the first min(len, 4096) bytes. */
const prefixSha = (buf) => sha256hex(buf.subarray(0, Math.min(buf.length, PREFIX_PROBE_BYTES)));

/** Every *.jsonl under the projects tree — main session, subagent transcripts (crawler parity). */
function findTranscripts(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findTranscripts(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** The anchor the fires would give this cwd: the repo's root commit (with the tray's display
 *  name), else the folder. the shallow-clone rule, 2026-09-16 (R2): under a SHALLOW clone the root is unknown
 *  (the parentless commit is the depth boundary — measured in Claude Code Cloud, declared as the
 *  repo and refused `not_consented` every turn); the declaration then carries the boundary as its
 *  key (a real commit this clone holds), the display the server resolves from, and
 *  `rootKnown: false` — the server answers the resolved anchor on the need and the chunks adopt it. */
function anchorFor(cwd) {
  const st = rootStateOf(cwd);
  const display = displayNameOf(cwd);
  if (st.root) return { anchor: { type: 'repo', key: `repo:${st.root}`, ...(display ? { display } : {}) }, rootKnown: true };
  if (!st.known && st.boundary) return { anchor: { type: 'repo', key: `repo:${st.boundary}`, ...(display ? { display } : {}) }, rootKnown: false };
  return { anchor: { type: 'folder', key: `folder:${cwd}` }, rootKnown: true };
}

/** The tray's identity for a transcript (crawler scan.rs, the 06-12 rule): the path under the PROJECT
 *  dir with the slug (the first segment) stripped, no extension, `/`-separated — so a subagent is
 *  `<parent>/subagents/…/agent-<id>` and rides its parent's substream downstream. The slug is the
 *  project dir's name, a descriptive label the tray sends beside the id. */
function identityOf(projectsDir, file) {
  const rel = relative(projectsDir, file).replace(/\\/g, '/').replace(/\.jsonl$/, '');
  const cut = rel.indexOf('/');
  if (cut < 0) return { id: rel, slug: '' };
  return { id: rel.slice(cut + 1), slug: rel.slice(0, cut) };
}

/** The transcript's own cwd from its head (the tray's read_head_cwd), or null. */
function headCwdOf(buf) {
  const head = buf.subarray(0, Math.min(buf.length, HEAD_BYTES)).toString('utf8');
  const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head);
  if (!m) return null;
  try { const v = JSON.parse(m[1]); return typeof v === 'string' && v ? v : null; } catch { return null; }
}

/** An unread body holds its socket, and a held socket holds the process open after the hook has
 *  returned (measured in the rig: a 401 left the courier alive until the harness's timeout). */
const drain = (res) => res.text().catch(() => '');

async function post(url, headers, body, kind) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // connection: close — an idle keep-alive socket would hold the hook process open after it has
    // returned (measured in the rig); the courier makes a handful of requests per turn, so nothing is lost
    return await fetch(url, { method: kind, headers: { ...headers, connection: 'close' }, body, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

export async function ship(payload, env = process.env) {
  // ── the surface gate: a remote harness (or the laptop proof's pin), the claude-code harness
  if (!isRemoteHarness(env) && env.PATHSAYER_SHIP !== '1') return { outcome: 'skip_local_capture' };
  // the remote surface IS Claude Code Cloud: CLAUDE_CODE_REMOTE alone (the doc's name) carries
  // no entrypoint for detectHarness to read, so remote + unknown reads as claude-code here
  // what ships is always the web harness — its sessions are their own substream per repo; a laptop
  // proof (PATHSAYER_SHIP=1 under `cli`) ships as the web too, since that is what it stands in for
  const d = detectHarness(env, payload);
  const harness = d.harness ?? (isRemoteHarness(env) ? CLOUD_HARNESS : null);
  if (harness !== CLOUD_HARNESS && harness !== 'claude-code') return { outcome: 'skip_harness', harness: d.harness };

  // ── the credential by the ladder (the tray's file · PATHSAYER_TOKEN · the cache · the cloud's
  //    bare send, where the environment's own proxy attaches it)
  const origin = resolveOrigin({ baked: await bakedOrigin() });
  const bearer = peekBearer({ origin });
  if (bearer === null) {
    // the shallow-clone rule (R5) — every outcome says one line: silence was how a whole environment shipped nothing
    say('no credential for this environment — set PATHSAYER_TOKEN (from /link on Home) in the environment\'s variables; transcripts are not being captured.');
    return { outcome: 'no_token' };
  }
  const authHeaders = bearer.token ? { authorization: `Bearer ${bearer.token}` } : {};

  // ── the transcripts
  const home = env.HOME || '/root';
  const projectsDir = env.PATHSAYER_PROJECTS_DIR || join(home, '.claude', 'projects');
  const files = findTranscripts(projectsDir);
  const payloadCwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  // each session anchors on ITS OWN head cwd (the tray's rule); the payload's cwd is the fallback
  // for a head that names none. One git resolution per distinct cwd.
  const byCwd = new Map();
  const placeOf = (cwd) => {
    let p = byCwd.get(cwd);
    if (!p) { p = { ...anchorFor(cwd), checkoutRoot: toplevelOf(cwd) }; byCwd.set(cwd, p); }
    return p;
  };
  const sessions = [];
  // the mask (2026-09-17): the whole buffer is masked once, here, so every page, prefix_sha and
  // content_sha256 below derive from masked bytes and a secret can never straddle two pages. Same
  // length by construction; the file on disk keeps its own bytes.
  const secrets = heldSecrets({ origin });
  for (const f of files) {
    let buf;
    try { buf = maskExact(readFileSync(f), secrets); } catch { continue; }
    const eof = alignedEof(buf);
    if (eof === 0) continue; // no complete line yet — hold
    const { id, slug } = identityOf(projectsDir, f);
    if (!id) continue;
    const place = placeOf(headCwdOf(buf) ?? payloadCwd);
    // origin 0: the server owns a session's origin (a head rewritten before the first ship); the
    // courier adopts the server's answer when another device set it (an `origin` need or answer)
    sessions.push({ id, slug, buf, eof, gen: 0, origin: 0, shippedTo: 0, ...place });
  }
  if (sessions.length === 0) {
    say(`no transcripts found under ${projectsDir} — nothing to ship this turn.`); // the shallow-clone rule (R5)
    return { outcome: 'no_transcripts' };
  }
  const version = await pluginVersion();
  const mine = new Map(sessions.map((s) => [s.id, s]));

  let shipped = 0;
  const refusedIds = new Set(); // once per run, per session — whichever wire refused it
  const unresolvedIds = new Set(); // the shallow-clone rule — refused because a shallow clone's display resolved to zero or several repos
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const shippedBefore = shipped;
    // ── declare (the facts wire): what this VM holds, never `full`
    let res;
    try {
      res = await post(`${origin}/local-ingest/reconcile`, { ...authHeaders, 'content-type': 'application/json' }, JSON.stringify({
        protocol_version: RECONCILE_PROTOCOL_FACTS,
        device_id: 'cloud', // the schema wants a name; the door scopes the device from the token, never this
        account_id: '',
        declarations: sessions.map((s) => ({ session_id: s.id, harness: CLOUD_HARNESS, anchor: s.anchor, byte_hwm: s.eof, generation: s.gen, prefix_sha: prefixSha(s.buf), origin_byte: s.origin, ...(s.rootKnown === false ? { root_known: false } : {}) })),
        full: false,
      }), 'POST');
    } catch (e) {
      say(`could not reach ${origin} to ship this session (${String(e?.message ?? e)}); it will retry on the next turn.`);
      return { outcome: 'transport_error' };
    }
    if (res.status === 401) {
      await drain(res);
      say('the cloud device\'s token was refused — the device may have been removed on Home, or PATHSAYER_TOKEN is wrong. This session is not being captured.');
      return { outcome: 'auth_error' };
    }
    if (!res.ok) {
      await drain(res);
      say(`shipping paused by the server (HTTP ${res.status}); it will retry on the next turn.`);
      return { outcome: 'halt', status: res.status };
    }
    const rec = await res.json().catch(() => ({}));
    // the server's consent at the DECLARATION: a repo not enabled for this cloud device is refused
    // here, with no need — nothing of it is shipped, nothing of it counts as behind
    for (const r of rec.refused ?? []) {
      if (!r || !mine.has(r.session_id)) continue;
      if (r.reason === 'not_consented') refusedIds.add(r.session_id);
      // the shallow-clone rule (R3/R5) — the server could not resolve a shallow clone's repo from its display: zero
      // or several enabled repos matched. Named, once per session per run: the display, and the
      // anchor(s) it found (the one to enable, or the ambiguity to settle).
      if (r.reason === 'unresolved_shallow_anchor' && !unresolvedIds.has(r.session_id)) {
        unresolvedIds.add(r.session_id);
        const cands = Array.isArray(r.candidates) ? r.candidates : [];
        const display = typeof r.display === 'string' ? r.display : (mine.get(r.session_id)?.anchor?.display ?? '?');
        say(cands.length === 0
          ? `this checkout is a shallow clone (its repo root is unknown) and '${display}' matches no repo enabled for this cloud device — enable it from the device's Sharing settings on Home to capture this session.`
          : cands.length === 1
            ? `this checkout is a shallow clone (its repo root is unknown); '${display}' is ${cands[0]}, which is not enabled for this cloud device — enable it from the device's Sharing settings on Home to capture this session.`
            : `this checkout is a shallow clone (its repo root is unknown) and '${display}' matches ${cands.length} repos on this device (${cands.join(', ')}) — the session is not captured until one of them is the only enabled '${display}'.`);
      }
    }
    const needs = (rec.needs ?? []).filter((n) => mine.has(n.session_id));
    let resynced = false;
    for (const need of needs) {
      const s = mine.get(need.session_id);
      // the shallow-clone rule (R3) — the anchor the server RESOLVED this session under (a shallow clone's display →
      // the device's enabled repo): adopted for the chunks, as an `origin` answer is adopted
      if (need.anchor && typeof need.anchor.key === 'string' && need.anchor.key !== s.anchor.key) {
        say(`this checkout is a shallow clone; the server resolved '${s.anchor.display ?? s.anchor.key}' to ${need.anchor.key} — shipping under it.`);
        s.anchor = { ...s.anchor, ...need.anchor };
      }
      // an `origin` need: the server holds a different origin for this session (another device set
      // it) — adopt it and re-declare under it; the next answer says what to ship, from where
      if (need.reason === 'origin') {
        if (typeof need.origin_byte === 'number') s.origin = need.origin_byte;
        resynced = true;
        continue;
      }
      let hwm = need.reason === 'resync' ? 0 : need.from_byte;
      if (need.reason === 'resync' && typeof need.generation === 'number') { s.gen = need.generation; resynced = true; }
      for (let i = 0; i < MAX_CHUNK_ITERS && hwm < s.eof; i++) {
        const to = Math.min(s.eof, hwm + MAX_CHUNK_BYTES); // the tray's page; the next iteration continues
        const slice = s.buf.subarray(hwm, to);
        const gz = gzipSync(slice);
        const envelope = {
          protocol_version: PROTOCOL_VERSION,
          client_version: `${version}-cloud`,
          harness: CLOUD_HARNESS,
          session_id: s.id,
          slug: s.slug || s.id,
          anchor: s.anchor,
          ...(s.rootKnown === false ? { root_known: false } : {}), // the shallow-clone rule (R2) — the chunk door's belt resolves it too
          ...(s.checkoutRoot ? { checkout_root: s.checkoutRoot } : {}),
          origin_byte: s.origin,
          from_byte: hwm,
          to_byte: to,
          prefix_sha: prefixSha(s.buf),
          generation: s.gen,
          payload_encoding: 'gzip',
          payload_len: gz.byteLength,
          content_sha256: sha256hex(slice),
        };
        let cr;
        try {
          cr = await post(`${origin}/local-ingest/chunk`, { ...authHeaders, 'x-pathsayer-ingest': b64urlJson(envelope), 'content-type': 'application/octet-stream' }, gz, 'PUT');
        } catch (e) {
          say(`could not reach ${origin} to ship this session (${String(e?.message ?? e)}); it will retry on the next turn.`);
          return { outcome: 'transport_error', shipped };
        }
        if (cr.status === 401) {
          await drain(cr);
          say('the cloud device\'s token was refused — the device may have been removed on Home, or PATHSAYER_TOKEN is wrong. This session is not being captured.');
          return { outcome: 'auth_error', shipped };
        }
        const body = await cr.json().catch(() => ({}));
        const status = body.status || `http_${cr.status}`;
        if (status === 'ok') { hwm = body.byte_hwm ?? to; s.shippedTo = hwm; shipped += to - envelope.from_byte; continue; }
        if (status === 'gap') { hwm = body.expected_byte_hwm ?? hwm; continue; }
        if (status === 'resync') { s.gen = body.generation ?? s.gen + 1; hwm = 0; resynced = true; continue; }
        if (status === 'origin') { if (typeof body.origin_byte === 'number') s.origin = body.origin_byte; resynced = true; break; } // re-declare under the server's origin
        if (status === 'not_consented') {
          // the chunk gate's consent (the declaration's answer came first; this is the race between
          // them): this repo is not enabled on this cloud device — captured nowhere by design
          // (sharing is per repo, per device, explicit). Once, per run, per session.
          refusedIds.add(s.id);
          s.shippedTo = s.eof;
          break;
        }
        say(`shipping paused by the server (${status}${body.message ? `: ${body.message}` : ''}); it will retry on the next turn.`);
        return { outcome: 'halt', status, shipped };
      }
    }
    // a resync re-declares under the new generation; a round that SHIPPED declares once more to
    // CONFIRM — the server computes the device's `behind` at the declaration, and this device has no
    // next tick after a session's last Stop (the tray refreshes it every 30 s; the courier must
    // itself). A round that shipped nothing is the confirm, and the run ends on it.
    if (!resynced && shipped === shippedBefore) break;
  }
  const refused = refusedIds.size + unresolvedIds.size;
  if (refusedIds.size > 0) say(`${refusedIds.size} session${refusedIds.size === 1 ? '' : 's'} on a repo not enabled for this cloud device — enable it from the device's Sharing settings on Home to capture them.`);
  return { outcome: 'ok', shipped, sessions: sessions.length, refused };
}

async function main() {
  const payload = await readStdin().catch(() => ({}));
  const r = await ship(payload).catch((e) => ({ outcome: 'fatal', err: String(e) }));
  if (process.env.PATHSAYER_SHIP_DEBUG === '1') process.stderr.write(JSON.stringify(r) + '\n');
}

// A hook ends by RETURNING, never by process.exit (the Windows libuv teardown, recon-hook.mjs).
// Run only as the entry script — the rig imports `ship` and drives it in-process.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 0; });
}
