// The ONE place every command hook gets its bearer, its state paths, and its epoch.
//
// Extracted from the shipped cache-or-redeem in recon-prompt.mjs and the (since removed,
// 2026-09-02) transcript shipper, with the four
// stamped changes (Gary, 2026-08-16): single-flight locking (a live probe reproduced the race:
// redeems=2, serves=1), per-origin+session state namespacing (the shipped cache was one file per
// user — part of why the race existed), a 2-minute refresh skew (was 60s), and the client-declared
// epoch counter (S3) living in the same directory under the same lock.
//
// TICKET SPEND RULE (corrected 2026-08-16 against the shipper's recorded semantics):
// a ticket is consumed ONLY on a successful redemption — then deleted, never re-redeemed (the
// lock + post-lock cache re-read is what makes the 156 race impossible). A 404 is AWAITING_MINT:
// the hook raced ahead of the model's mint_client_token call, nothing is stashed server-side,
// and the ticket SURVIVES for the next hook. A network error reports 'transport' and keeps it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Origin precedence: PATHSAYER_ORIGIN > legacy PATHSAYER_BASE (the named migration) > the
 *  plugin's BAKED default. Hooks never guess from ambient state beyond these. */
export function resolveOrigin({ baked }) {
  return process.env.PATHSAYER_ORIGIN || process.env.PATHSAYER_BASE || baked;
}

/** The crawl home — /home/claude when its .claude exists, else os home. THE CONTAINER QUIRK
 *  (the old shipper's load-bearing comment: "never simplify the token path to ~"): cowork containers
 *  run with HOME=/root while the crawl home is /home/claude; state must live where the crawl
 *  reads. `existsFn` injectable for tests — machine state is not a fixture. */
export function crawlHome(existsFn = existsSync) {
  return existsFn('/home/claude/.claude') ? '/home/claude' : homedir();
}

/** The per-(origin-host, session) state dir, mode 0700. PATHSAYER_HOOK_STATE relocates the root
 *  (tests; containers). Origins never share a bearer; sessions never share a bearer or epoch. */
/** The MACHINE's dir for an origin: the bearer lives here, above every session
 *  (one mint per machine; every session on it is armed). 0700. */
export function originDir({ origin }) {
  const root = process.env.PATHSAYER_HOOK_STATE || join(crawlHome(), '.pathsayer', 'hook-state');
  const host = String(origin).replace(/^[a-z]+:\/\//i, '').replace(/[^\w.-]/g, '_');
  const dir = join(root, host);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return dir;
}

/** A SESSION's dir under its origin: the ticket (one mint attempt) and the epoch live here. */
export function stateDir({ origin, sessionId }) {
  const dir = join(originDir({ origin }), String(sessionId).replace(/[^\w.-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return dir;
}

/** Which harness produced this hook fire — and whether that surface may SHIP transcripts.
 *  PAYLOAD OUTRANKS ENV: codex 0.147.0 (measured 2026-08-16, live dump-env probe) sets NO env
 *  of its own for hook processes and passes the PARENT env through — a codex launched from
 *  inside a Claude Code session inherits CLAUDE_CODE_ENTRYPOINT=cli, so env alone would
 *  mislabel it. Codex hook stdin carries `turn_id` (Claude's does not; a live capture
 *  agrees) — read what the harness declared, the same rule that anchors codex_anchor.
 *
 *  The label only (nothing ships, so there is no "shippable" bit): it anchors
 *  the plugin build header and the mint policy. PATHSAYER_HARNESS forces it (the rig's seam).
 *  Unknown → null: never guess a surface (a wrong harness fragments substreams). */
export function detectHarness(env, payload = {}) {
  if (env.PATHSAYER_HARNESS) return { harness: env.PATHSAYER_HARNESS };
  if (payload.turn_id != null) return { harness: 'codex' };
  const entry = env.CLAUDE_CODE_ENTRYPOINT;
  if (!entry) return { harness: null };
  if (entry === 'remote_cowork') return { harness: 'cowork' };
  // 'remote' = Claude Code Web (claude.ai/code). Measured live (2026-08-25, CLI 2.1.245).
  // 2026-09-15: its OWN harness — a repo's cloud sessions are their own substream, shared from
  // the cloud device's card; the server reads its transcripts as Claude Code's format.
  if (entry === 'remote') return { harness: 'claude-code-web' };
  if (env.PATHSAYER_ENTRYPOINT_CLAUDE_CODE && entry === env.PATHSAYER_ENTRYPOINT_CLAUDE_CODE) return { harness: 'claude-code' };
  if (entry === 'cli') return { harness: 'claude-code' };
  // 'claude-desktop' = the Claude desktop app's Code tab — the same harness on the same machine as
  // `cli`, not a new surface. Measured 2026-09-10 (Cameron, Windows): unknown here, his desktop
  // sessions never minted and sent no plugin header, so they served on a CLI-minted bearer and were
  // invisible on /admin.
  if (entry === 'claude-desktop') return { harness: 'claude-code' };
  return { harness: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Single-flight: an atomic mkdir lock, polled, with stale-steal so a crashed hook cannot
 *  deadlock every future one. Cross-process by construction (mkdir is atomic on one fs). */
export async function withLock(dir, fn, { staleMs = 10_000, timeoutMs = 3_000 } = {}) {
  const lock = join(dir, '.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { continue; /* lock vanished between check and stat — retry immediately */ }
      if (Date.now() > deadline) throw new Error('hookauth: lock timeout');
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// PATHSAYER_TOKEN_FILE / PATHSAYER_TICKET_FILE override the per-session paths — the rig's and
// the containers' pinning seam, honored for migration compatibility (the old shipper's rig set
// both; a pinned container must keep reading where the crawl expects).
/** The bearer is the MACHINE's: `<origin dir>/bearer.json`, above every session. */
const bearerPath = (odir) => process.env.PATHSAYER_TOKEN_FILE || join(odir, 'bearer.json');
const ticketPath = (dir) => process.env.PATHSAYER_TICKET_FILE || join(dir, 'ticket.json');
/** A pinned path may point into a directory nothing has created yet (fresh container homes —
 *  the old consumers mkdir'd before every write, and the rig proved the module must too). */
const writeSecure = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data, { mode: 0o600 }); };

// ── THE LADDER (2026-09-15) ──────────────────────────────────────────────────────
// The bearer comes from, in order: (1) the TRAY's file — the signed-in tray mints the plugin's
// client token through its own grant and writes it beside its bearer, env-keyed
// (`~/.config/pathsayer/client-token-<host>.json`, `{ token, origin, minted_at }`); (2) the
// PATHSAYER_TOKEN environment variable — a tray-less machine, or a cloud environment's credential;
// (3) the cached bearer the mint directive redeemed (the un-migrated shape); (4) nothing. Rungs
// 1 and 2 are READ every fire and never written, cached or deleted by a hook — the tray owns its
// file's life (a 401 on a tray-sourced token deletes nothing; the tray's next start rewrites it).
// The path is the OS home, never the crawl home: the tray writes where the OS says home is
// (Windows: %USERPROFILE%), and a container has no tray.

/** The tray's env key, exactly as the tray computes it (crawler `oauth::env_key`): host[:port]
 *  with scheme and path stripped, any char outside [A-Za-z0-9.-] mapped to `_`. */
export function envKeyOf(origin) {
  const s = String(origin).trim().replace(/\/+$/, '');
  const host = s.replace(/^https?:\/\//i, '').split('/')[0];
  return host.replace(/[^A-Za-z0-9.-]/g, '_');
}

/** Where the tray writes the plugin's client token for this origin. */
export function trayTokenPath({ origin }) {
  return join(homedir(), '.config', 'pathsayer', `client-token-${envKeyOf(origin)}.json`);
}

/** Rung 1. A torn, empty, or other-origin file is absent — never a throw (hooks are fail-open). */
function trayBearer({ origin }) {
  try {
    const f = JSON.parse(readFileSync(trayTokenPath({ origin }), 'utf8'));
    if (!f || typeof f.token !== 'string' || f.token === '') return null;
    if (typeof f.origin === 'string' && f.origin !== '' && envKeyOf(f.origin) !== envKeyOf(origin)) return null;
    return { token: f.token, ingest_base: origin, source: 'tray' };
  } catch { return null; }
}

/** Rung 2. */
function envBearer({ origin }) {
  const t = process.env.PATHSAYER_TOKEN;
  return typeof t === 'string' && t !== '' ? { token: t, ingest_base: origin, source: 'env' } : null;
}

/** Rung 3 — the cached bearer, or null. NO refresh skew — there is nothing to refresh. A
 *  135 bearer carries no `expires_at` (it lives as long as its grant, which the server checks on
 *  every fire); a LEGACY bearer (pre-135, `expires_at` set) is honoured until it expires, then
 *  absent. The 30-minute cadence and its 2-minute skew were retired 2026-09-02. */
function usableBearer(odir) {
  try {
    const b = JSON.parse(readFileSync(bearerPath(odir), 'utf8'));
    if (b?.token && (typeof b.expires_at !== 'number' || b.expires_at > Date.now())) return { ...b, source: 'cache' };
  } catch { /* absent or torn */ }
  return null;
}

/** The migration (2026-09-15, Gary: "if i sign out of the tray wont i be in some half auth'd
 *  state?" — yes, until this): a fire that read the TRAY's file retires the hooks' OWN cached
 *  bearer for that origin (rung 3, the mint directive's redeem of months ago). Left in place it
 *  outlived the tray's sign-out — the tray's file goes, the ladder falls through to a cache that is
 *  still valid against the connector grant, and the hooks keep firing on a machine that reads
 *  signed out. Only the tray rung retires it: a PATHSAYER_TOKEN machine has no tray to fall back
 *  from. The tray's file is never touched here. Best effort, fail-open. */
function retireCachedBearer({ origin }) {
  try { unlinkSync(bearerPath(originDir({ origin }))); } catch { /* none, or not ours to remove */ }
}

/** Rungs 1 and 2 — the ones no lock guards (reads only, nothing of the hooks' own — except that a
 *  tray-sourced read retires the hooks' own stale cache, above). */
const outerBearer = ({ origin }) => {
  const tray = trayBearer({ origin });
  if (tray) { retireCachedBearer({ origin }); return tray; }
  return envBearer({ origin });
};

/** Claude Code Web: CLAUDE_CODE_ENTRYPOINT=remote (measured 2026-08-25) or CLAUDE_CODE_REMOTE
 *  (the cloud-environments doc's name). Never a local cli, never codex. */
export function isRemoteHarness(env) {
  return env.CLAUDE_CODE_ENTRYPOINT === 'remote' || (typeof env.CLAUDE_CODE_REMOTE === 'string' && env.CLAUDE_CODE_REMOTE !== '');
}

/** THE CLOUD RUNG (last, 2026-09-15): on Claude Code Web the environment attaches an API
 *  credential to our host through its own proxy — the key never enters the sandbox, so no local
 *  rung can hold it. With nothing local, a hook or the MCP proxy sends BARE (no Authorization
 *  header) and lets the environment's proxy add it; a plain PATHSAYER_TOKEN variable (rung 2)
 *  still wins when the environment passes one. The mint hook says nothing here: there is no tray
 *  to sign in to, and the credential lives on the environment, not in the session. */
function remoteBearer({ origin }) {
  return isRemoteHarness(process.env) ? { token: null, ingest_base: origin, source: 'remote' } : null;
}

/** The machine's bearer by the ladder, WITHOUT a redeem: the tray's file, the variable, the
 *  cached bearer, or the cloud's bare send — or null. What the MCP proxy reads on every message
 *  (it never mints; a hook redeems through getBearer). */
export function peekBearer({ origin }) {
  return outerBearer({ origin }) ?? usableBearer(originDir({ origin })) ?? remoteBearer({ origin });
}

/** Is this machine armed for the origin, by any rung? The mint hook's check: none → one line to
 *  the user (and, until the op retires, the directive), ONCE; any → silence, whatever session. */
export function hasBearer({ origin }) {
  return peekBearer({ origin }) !== null;
}

/** The 401 path for the CACHED bearer: the server said the grant is gone (S0's gate), so the
 *  machine bearer is dead; drop it and the next prompt's mint hook re-arms. Never for any other
 *  failure: a hiccup is not a revocation. Touches nothing of the tray's or the environment's. */
export async function dropBearer({ origin }) {
  const odir = originDir({ origin });
  await withLock(odir, () => { try { unlinkSync(bearerPath(odir)); } catch { /* already gone */ } });
}

/** Cache-or-redeem under the single-flight lock, with the POST-LOCK RE-READ that closes 156's
 *  race: the second waiter finds the first waiter's cache instead of re-redeeming.
 *  → { token, ... } on success; { status: 'not_armed' | 'redeem_failed' | 'cache_write_failed' }
 *  otherwise. Never throws for flow reasons — hooks are fail-open. */
export async function getBearer({ origin, sessionId, timeoutMs = 2_500, fetchImpl = fetch }) {
  // Rungs 1 and 2 first: the tray's file or the environment — read, never redeemed or cached.
  const outer = outerBearer({ origin });
  if (outer) return outer;
  // The lock and the bearer are the ORIGIN's (one mint per machine); the ticket
  // being redeemed is this session's.
  const odir = originDir({ origin });
  const dir = stateDir({ origin, sessionId });
  return withLock(odir, async () => {
    const cached = usableBearer(odir); // the post-lock re-read
    if (cached) return cached;
    let ticket;
    try { ticket = JSON.parse(readFileSync(ticketPath(dir), 'utf8')).ticket; } catch { /* none */ }
    if (!ticket) return remoteBearer({ origin }) ?? { status: 'not_armed' }; // the cloud rung is last
    let res;
    try {
      res = await fetchImpl(`${origin}/mint/redeem`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { status: 'transport' }; // no response — the ticket SURVIVES for the next hook
    }
    // 404 = the model has not minted yet (nothing stashed under the ticket) — AWAITING_MINT,
    // and the ticket survives. Other failures are transport-class; the ticket also survives
    // (nothing was consumed). Only SUCCESS consumes.
    if (res.status === 404) return { status: 'awaiting_mint' };
    if (!res.ok) return { status: 'transport' };
    let bundle;
    try { bundle = await res.json(); } catch { return { status: 'transport' }; }
    if (!bundle?.token) return { status: 'transport' };
    try { unlinkSync(ticketPath(dir)); } catch { /* already gone */ } // consumed server-side
    try {
      writeSecure(bearerPath(odir), JSON.stringify(bundle));
    } catch {
      return { status: 'cache_write_failed', ...bundle, source: 'cache' }; // spent ticket already deleted — reported, not retried
    }
    return { ...bundle, source: 'cache' };
  });
}

/** Stage a ticket for this session (the mint hook's half). Under the lock so it cannot tear a
 *  concurrent redeem. */
export async function stageTicket({ origin, sessionId, ticket }) {
  const dir = stateDir({ origin, sessionId });
  await withLock(dir, () => writeSecure(ticketPath(dir), JSON.stringify({ ticket })));
}

/** §3 lifecycle, the SessionEnd sweep: the ticket dies with the session unconditionally (the
 *  next session's mint hook stages its own), the bearer only when EXPIRED — a resumed session
 *  keeps its session_id and may still use the fresh cache. Same lock; pinned paths honored.
 *  Stop fires must NOT call this — mid-session residue is the working state. */
export async function endSession({ origin, sessionId }) {
  // The ticket is the session's and dies with it; the bearer is the MACHINE's and
  // survives every session. Only an EXPIRED legacy bearer (pre-135) is swept here, as before.
  const odir = originDir({ origin });
  const dir = stateDir({ origin, sessionId });
  await withLock(odir, () => {
    try { unlinkSync(ticketPath(dir)); } catch { /* none staged */ }
    if (!usableBearer(odir)) { try { unlinkSync(bearerPath(odir)); } catch { /* none cached */ } }
  });
}

// ── the client-declared epoch (ruled 2026-08-16) ────────────────────────────────
// Compaction and subagent-close are CLIENT events; the counter lives here and rides every serve
// request as `epoch`. Suppression stays per (session, context, epoch) server-side — another
// tab's session has its own directory, so its own counter: the multi-tab guarantee.
const epochPath = (dir) => join(dir, 'epoch.json');

export function readEpoch({ origin, sessionId }) {
  try { return JSON.parse(readFileSync(epochPath(stateDir({ origin, sessionId })), 'utf8')).epoch ?? 0; } catch { return 0; }
}

export async function bumpEpoch({ origin, sessionId }) {
  const dir = stateDir({ origin, sessionId });
  return withLock(dir, () => {
    let cur = 0;
    try { cur = JSON.parse(readFileSync(epochPath(dir), 'utf8')).epoch ?? 0; } catch { /* first bump */ }
    const next = cur + 1;
    writeFileSync(epochPath(dir), JSON.stringify({ epoch: next }), { mode: 0o600 });
    return next;
  });
}
