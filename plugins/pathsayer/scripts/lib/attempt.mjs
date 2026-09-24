// 2026-09-23 — the plugin half of the harness-by-place abstraction: what a session in a
// constellation ATTEMPT does at its hooks, on all four cells (Claude or Codex, cloud or laptop).
// Four operations, one rule each, the per-cell differences as details (measured 2026-09-23 in
// both cloud environments and in worktrees on a laptop — cells C17, C19, C21, C22):
//   handshake  the start prompt's first line is `pathsayer-attempt: <id>`; the first-prompt hook
//              matches it on the RAW prompt text (never on anything the model says), keeps the id
//              in per-session state, and presents it to the server until the server confirms —
//              the server binds once, while the attempt is starting, from its device.
//   save       at Stop, before the ask: commit if the tree is dirty (Claude leaves it dirty; Codex
//              Cloud commits itself before Stop; local Codex does not), `git bundle create` from
//              the START ref to HEAD, PUT to the bundle endpoint. The start ref is recorded at
//              SessionStart — FETCH_HEAD in a cloud clone, the reflog's first entry in a worktree,
//              else HEAD — never "HEAD at the first stop" (C17's finding: the platform had already
//              committed). A head already uploaded is never re-sent.
//   pull       the stop ask: "I stopped, here is my last message, anything more?" — short asks
//              until a task comes back or the budget the server handed is spent; a task becomes
//              `{"decision":"block","reason":<Pathsayer's own rendering>}` and the session
//              continues with it as its instruction (both harnesses honour it — C14, C21);
//              nothing → one final ask that says so, and the session ends (the server marks it
//              finished on that ask).
//   apply      a successor's first prompt: GET the predecessor's bundle by key, verify, fetch,
//              fast-forward, one context line (C21).
// Every piece of state is keyed by SESSION id (hookauth.stateDir), never by container or home —
// a Claude cloud container is reused across sessions (C22). Fail-open like every hook: nothing
// here throws to the harness; a failure is an outcome the caller reports.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { crawlHome, detectHarness, isCodexCloud, isRemoteHarness, stateDir } from './hookauth.mjs';

/** The attempt id's shape — `att_` + 16 hex (like the tray's `dev_`). */
export const ATTEMPT_ID = /^att_[0-9a-f]{16}$/;
const ATTEMPT_LINE = /^pathsayer-attempt:\s*(att_[0-9a-f]{16})\s*$/;

/** The identity a commit made by the hook carries when the checkout has none configured. */
const HOOK_IDENTITY = ['-c', 'user.name=Pathsayer', '-c', 'user.email=hook@pathsayer.com'];

/** git in a directory, stdout as text; stderr is captured so a failure can be reported. */
function run(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
const errText = (e) => String(e?.stderr ?? e?.message ?? e).trim();

/** The first line of the raw prompt, and only the first line: `pathsayer-attempt: <id>` → the id,
 *  else null. A mention anywhere else binds nothing. */
export function attemptLineOf(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return null;
  const first = prompt.split('\n', 1)[0].replace(/\r$/, '');
  const m = ATTEMPT_LINE.exec(first);
  return m ? m[1] : null;
}

/** The ref a checkout started from, for the bundle's base: FETCH_HEAD when the clone has one (a
 *  cloud container's fetch — C7, C17), else the oldest reflog entry of HEAD (a worktree — C19),
 *  else HEAD; null when the directory is not a repo. */
export function startRefOf(cwd) {
  try { const f = run(cwd, ['rev-parse', '-q', '--verify', 'FETCH_HEAD^{commit}']).trim(); if (f) return f; } catch { /* no FETCH_HEAD */ }
  try {
    const entries = run(cwd, ['log', '-g', '--format=%H', 'HEAD']).trim().split('\n').filter(Boolean);
    if (entries.length > 0) return entries[entries.length - 1];
  } catch { /* no reflog */ }
  try { return run(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() || null; } catch { return null; }
}

const statePath = (ctx) => join(stateDir(ctx), 'attempt.json');
/** The id a session's prompt named, kept by SESSION alone (the per-origin state above is where
 *  the bind lands): an id matched while the server could not be reached is presented again on
 *  the next prompt, whatever origin that fire resolves. */
function keptIdPath(sessionId) {
  const root = process.env.PATHSAYER_HOOK_STATE || join(crawlHome(), '.pathsayer', 'hook-state');
  const dir = join(root, 'attempt-ids');
  mkdirSync(dir, { recursive: true });
  return join(dir, String(sessionId).replace(/[^\w.-]/g, '_'));
}

/** The session's attempt state (`attempt.json` under hookauth.stateDir), or null. A state that
 *  names no attempt takes the session's kept id, unbound, when one was matched. */
export function loadAttempt(ctx) {
  let st = null;
  try { st = JSON.parse(readFileSync(statePath(ctx), 'utf8')); } catch { st = null; }
  if (st?.attempt_id) return st;
  let kept = null;
  try { kept = readFileSync(keptIdPath(ctx.sessionId), 'utf8').trim(); } catch { kept = null; }
  if (!kept || !ATTEMPT_ID.test(kept)) return st;
  return { ...(st ?? {}), attempt_id: kept, bound: false, refused: false };
}

/** Merge `patch` into the session's attempt state and return the whole. A patch that names the
 *  attempt also keeps the id by session. */
export function saveAttempt(ctx, patch) {
  const next = { ...(loadAttempt(ctx) ?? {}), ...patch };
  writeFileSync(statePath(ctx), JSON.stringify(next), { mode: 0o600 });
  if (typeof patch.attempt_id === 'string') { try { writeFileSync(keptIdPath(ctx.sessionId), patch.attempt_id, { mode: 0o600 }); } catch { /* best-effort */ } }
  return next;
}

/** The harness a session ships as — the courier's rule: the two cloud environments are their own
 *  harnesses; a laptop ships as the harness that fired. Null when unknown (never guessed). */
export function attemptHarnessOf(env, payload) {
  if (isCodexCloud(env)) return 'codex-cloud';
  const { harness } = detectHarness(env, payload);
  if (isRemoteHarness(env)) return harness === 'codex' ? 'codex-cloud' : 'claude-code-cloud';
  return harness ?? null;
}

/** The save: commit if dirty, bundle `<base>..HEAD`. Returns `{ head, committed, bytes }` —
 *  `bytes` null when HEAD is the base or the head already uploaded (`lastHead`). */
export function save({ cwd, base, lastHead, message }) {
  let committed = false;
  const dirty = run(cwd, ['status', '--porcelain', '--untracked-files=all']).trim() !== '';
  if (dirty) {
    let identity = [];
    try { if (run(cwd, ['config', 'user.email']).trim() === '') identity = HOOK_IDENTITY; } catch { identity = HOOK_IDENTITY; }
    run(cwd, ['add', '-A']);
    run(cwd, [...identity, 'commit', '-q', '-m', message ?? 'Pathsayer: work at stop']);
    committed = true;
  }
  const head = run(cwd, ['rev-parse', 'HEAD']).trim();
  if (head === base || head === lastHead) return { head, committed, bytes: null };
  const dir = mkdtempSync(join(tmpdir(), 'ps-bundle-'));
  const file = join(dir, 'attempt.bundle');
  try {
    run(cwd, ['bundle', 'create', '-q', file, base ? `${base}..HEAD` : 'HEAD']);
    return { head, committed, bytes: readFileSync(file) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The apply: a bundle's bytes into this checkout — verify, fetch, fast-forward. Returns
 *  `{ ok: true, head, commits }` or `{ ok: false, reason, message }`. */
export function applyBundle({ cwd, bytes }) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-apply-'));
  const file = join(dir, 'predecessor.bundle');
  try {
    writeFileSync(file, bytes);
    let before;
    try { before = run(cwd, ['rev-parse', 'HEAD']).trim(); } catch (e) { return { ok: false, reason: 'not_a_repo', message: errText(e) }; }
    try { run(cwd, ['bundle', 'verify', file]); } catch (e) { return { ok: false, reason: 'verify', message: errText(e) }; }
    try { run(cwd, ['fetch', '-q', file, 'HEAD']); } catch (e) { return { ok: false, reason: 'fetch', message: errText(e) }; }
    try { run(cwd, ['merge', '-q', '--ff-only', 'FETCH_HEAD']); } catch (e) { return { ok: false, reason: 'fast_forward', message: errText(e) }; }
    const head = run(cwd, ['rev-parse', 'HEAD']).trim();
    const commits = Number(run(cwd, ['rev-list', '--count', `${before}..HEAD`]).trim());
    return { ok: true, head, commits };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Pathsayer's own rendering of a task as the model's instruction (never raw member text passed
 *  as an instruction to another account's session without this frame). Carries the task's id and
 *  text, its log, and the result-line ask. */
export function renderTask(task) {
  const lines = [`Pathsayer task ${task.id}:`, '', String(task.text ?? '').trim(), ''];
  const log = Array.isArray(task.log) ? task.log : [];
  if (log.length > 0) {
    lines.push('Log (written by Pathsayer; the earlier attempts and their stops):');
    for (const e of log) lines.push(`- [${e.kind ?? 'note'}${e.at ? ' ' + e.at : ''}] ${String(e.text ?? '').trim()}`);
    lines.push('');
  }
  lines.push('End your final message with one line, `Result: done` or `Result: cannot finish`, followed by a sentence or two. Then stop.');
  return lines.join('\n');
}

const jsonHeaders = (headers) => ({ ...headers, 'content-type': 'application/json', connection: 'close' });
const drain = (res) => res.text().catch(() => '');

/** The handshake: POST /local-ingest/attempt/handshake. Resolves to the server's answer
 *  (`{ bound, card?, wait_s?, bundle_key?, reason? }`) or `{ bound: false, reason }` — `unreachable`
 *  for a transport failure, `http_<status>` for a refusal. */
export async function handshake({ origin, headers, attemptId, sessionId, cwd, harness, fetchImpl = fetch, timeoutMs = 8000 }) {
  try {
    const res = await fetchImpl(`${origin}/local-ingest/attempt/handshake`, {
      method: 'POST',
      headers: jsonHeaders(headers),
      body: JSON.stringify({ attempt_id: attemptId, session_id: sessionId, cwd, harness }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { await drain(res); return { bound: false, reason: `http_${res.status}` }; }
    const body = await res.json().catch(() => null);
    if (!body || typeof body.bound !== 'boolean') return { bound: false, reason: 'unreachable' };
    return body;
  } catch { return { bound: false, reason: 'unreachable' }; }
}

/** GET /local-ingest/bundle?key= — the bytes, or null. */
export async function fetchBundle({ origin, headers, key, fetchImpl = fetch, timeoutMs = 20_000 }) {
  try {
    const res = await fetchImpl(`${origin}/local-ingest/bundle?key=${encodeURIComponent(key)}`, { headers: { ...headers, connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { await drain(res); return null; }
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

/** The stop ask: POST /local-ingest/attempt/stop in short asks until a task or the budget is
 *  spent; the first answer's `wait_s` sets the budget. Resolves to `{ task, wait_s }` or null —
 *  after one final ask marked `ending: true` when the server answered and had nothing (the moment
 *  it marks the session finished; `report.ending` says the final ask was made), or at once when
 *  the door refused or could not be reached (fail-open; the next stop asks again). */
export async function stopAsk({ origin, headers, attemptId, sessionId, lastMessage, transcriptBytes, bundleError, budgetS = 540, maxWaitS = null, intervalMs = 10_000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 20_000, report = {} }) {
  const started = Date.now();
  // `maxWaitS` (2026-09-23): a CAP on the wait, over the server's number — the rig's seam
  // (PATHSAYER_ATTEMPT_MAX_WAIT_S in ship.mjs) so a run against a real server ends in seconds; never
  // set by a member's environment, where the server's number is the wait.
  const cap = (ms) => (typeof maxWaitS === 'number' && Number.isFinite(maxWaitS) ? Math.min(ms, Math.max(0, maxWaitS) * 1000) : ms);
  let budgetMs = cap(budgetS * 1000);
  let asked = 0;
  const post = async (extra) => {
    asked += 1;
    try {
      const res = await fetchImpl(`${origin}/local-ingest/attempt/stop`, {
        method: 'POST',
        headers: jsonHeaders(headers),
        body: JSON.stringify({ attempt_id: attemptId, session_id: sessionId, last_message: lastMessage ?? null, transcript_bytes: transcriptBytes ?? null, asked, ...(bundleError ? { bundle_error: bundleError } : {}), ...extra }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { await drain(res); return null; }
      return await res.json().catch(() => null);
    } catch { return null; }
  };
  for (let first = true; ; first = false) {
    const a = await post({});
    if (a === null) return null;
    if (a.task && typeof a.task === 'object') return { task: a.task, wait_s: a.wait_s, ...(typeof a.attempt_id === 'string' ? { attempt_id: a.attempt_id } : {}) }; // the NEW attempt the task runs as (R9) — the caller adopts it
    if (first && typeof a.wait_s === 'number' && Number.isFinite(a.wait_s)) budgetMs = cap(Math.max(0, a.wait_s) * 1000);
    // the server does not know this session as the attempt's: nothing to wait for and nothing to end
    // — no ending ask, and the caller never marks the attempt finished (the state stays live for the
    // next stop, which presents whatever the server last bound)
    if (a.unbound === true) { report.unbound = true; return null; }
    if (Date.now() - started + intervalMs > budgetMs) break;
    await sleep(intervalMs);
  }
  const fin = await post({ ending: true });
  if (fin !== null) report.ending = true;
  return null;
}

/** The last assistant message from the transcript's tail, when the harness's Stop payload did not
 *  carry one (Claude Code Cloud's older CLI is unverified for `last_assistant_message`). Reads the
 *  last 256 KB; Claude's `assistant` records and Codex's assistant `response_item`s. Null when none. */
export function lastMessageFromTranscript(path) {
  let buf;
  try { buf = readFileSync(path); } catch { return null; }
  const tail = buf.subarray(Math.max(0, buf.length - 256 * 1024)).toString('utf8');
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec?.type === 'assistant') {
      const content = rec.message?.content;
      const text = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : typeof content === 'string' ? content : null;
      if (text) return text;
    }
    if (rec?.type === 'response_item' && rec.payload?.role === 'assistant') {
      const c = rec.payload.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : null;
      if (text) return text;
    }
  }
  return null;
}

/** Where a laptop attempt's transcript tree starts, from the transcript's own path: Claude's
 *  `projects/<slug>/<id>.jsonl` → `projects`; Codex's `sessions/YYYY/MM/DD/rollout-…` → `sessions`. */
export function treeRootOf(transcriptPath, codex) {
  let d = dirname(transcriptPath);
  for (let i = 0; i < (codex ? 3 : 1); i++) d = dirname(d);
  return d;
}
