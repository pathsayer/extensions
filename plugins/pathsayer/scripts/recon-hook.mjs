#!/usr/bin/env node
// THE ONE command-hook adapter, replacing every mcp_tool recon entry.
//
//   node recon-hook.mjs            (no arguments — 2026-09-08)
//
// hooks.json carries NO behavior: one bare entry per harness event + matcher. This script reads
// the harness's own `hook_event_name` and `tool_name` from stdin and decides what to do. Until
// 2026-09-08 the entry passed `--lane <name> "<label>"` (args-claimed labeling, Gary 2026-07-19):
// two entries on PostToolUse:Bash were two node processes per Bash call, the authored label had
// drifted three ways in the ledger under one surface, and every hooks.json edit re-prompts every
// Codex user to re-trust the set. The 07-19 concern — never INFER the label — is met by
// reading the harness's declaration; any argv is ignored (a stale hooks.json in a running session
// must not change behavior).
//
// Shapes by (event, tool): PreToolUse:Edit|Write|apply_patch → edit; PreToolUse:Agent|Task|
// spawn_agent → task; PreToolUse:Bash → bash; UserPromptSubmit → prompt; PostToolUse:Read → read;
// PostToolUse:Bash → the FORK: a `git commit` walks (deep recon on a commit — the diff is the
// fire), anything else serves the output; SessionStart / PreCompact → epoch. Anything else: nothing.
//
// The ledger surface is the RAW harness label (`PreToolUse:Edit`, `PostToolUse:Bash`, …,
// 2026-09-08): what fired, never a name of ours. A Codex edit is therefore `PreToolUse:apply_patch`, its
// own value; a Codex read is a `PostToolUse:Bash` (it has no read tool).
//
// Flow (serve shapes): stdin hook JSON → surface-carrying /api/recon body → hookauth bearer
// (cache-or-redeem; unarmed → silent no-op, the mint hook arms) → POST → the server's
// hookSpecificOutput envelope passes through to stdout VERBATIM. Both harnesses share the stdin
// field names (measured: Claude 2.1.223 live probe + Codex 0.147.0 via a live Codex probe); Codex
// additionally sends turn_id, and its apply_patch fires extract spans from the patch grammar with
// the PRE-IMAGE as the region pin (recon matches what the code IS).
//
// Epoch (S3, ruled 2026-08-16): PreCompact and SessionStart(source=compact) bump the LOCAL
// counter (hookauth.bumpEpoch — same dir + lock as the ticket cache) and NEVER cross the network.
// SubagentStop bumps nothing: the retired MCP op's closeContext freed server-isolate memory — a
// concern this design does not have — and bumping the shared per-session counter there would
// clear MAIN's suppression on every subagent exit.
//
// FAIL-OPEN everywhere: no bearer, transport error, non-200, malformed response → exit 0,
// no stdout, the turn is never blocked.
//
// Deep recon on a commit (2026-09-01, PostToolUse:Bash): when the command was a `git commit` and a
// commit landed just now, this adapter runs `git show HEAD -U3` in the hook's cwd and posts the
// diff; the server walks it (the same recon_walk the MCP op runs) and answers the header + checks.
// The model never carries the diff (the 07-22 premise that "a hook cannot run git diff" was true
// of a templated hook, not of this script), and the walk lands in the ledger under the session,
// not 'anon'. Its one exception to fail-open silence: a commit is never silently unchecked — when
// the walk cannot be served (not armed, server down, a very large diff) the adapter emits the
// DIRECTIVE instead, and the model walks it itself. A commit command that did not land (rejected,
// nothing to commit) is silence — a commit is never served as if its summary were code.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs'; // the root-commit cache (rootOf)
import { join } from 'node:path';

import { resolveOrigin, getBearer, dropBearer, readEpoch, bumpEpoch, detectHarness } from './lib/hookauth.mjs';
import { DIRECTIVE, isGitCommit } from './commit.mjs';

/** The plugin's baked origin (build-generated); source-tree runs (the rig) fall back to
 *  prod, which the rig's PATHSAYER_ORIGIN pin overrides anyway. */
async function bakedOrigin() {
  try { return (await import('./lib/origin.mjs')).BAKED_ORIGIN; } catch { return 'https://pathsayer.com'; }
}

/** x-pathsayer-plugin: `<harness>/<version>` — the build stamp from the plugin's own
 *  plugin.json (build.mjs writes it), the harness from the same detector that anchors shipping.
 *  Null when either is unknown (never guess a surface); the server then simply records nothing. */
export function pluginTag(env, payload, version) {
  const { harness } = detectHarness(env, payload);
  if (!harness || typeof version !== 'string' || version === '') return null;
  return `${harness}/${version}`;
}

async function bakedPluginVersion() {
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pj = JSON.parse(readFileSync(path.join(here, '../.claude-plugin/plugin.json'), 'utf8'));
    return typeof pj.version === 'string' ? pj.version : null;
  } catch {
    return null;
  }
}

/** The measured apply_patch grammar: per file-header, collect the body; the pre-image is the
 *  context (' ') + removed ('-') lines — never the authored ('+') side. */
export function extractPatchSpans(patch) {
  if (typeof patch !== 'string') return [];
  const spans = [];
  let file = null;
  let body = [];
  const flush = () => {
    if (!file || body.length === 0) return;
    const pre = body.filter((l) => (l.startsWith(' ') || (l.startsWith('-') && !l.startsWith('---')))).map((l) => l.slice(1));
    spans.push({ file, pre: pre.join('\n') });
  };
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { flush(); file = m[1]; body = []; } else if (file) body.push(line);
  }
  flush();
  return spans;
}

/** The RAW surface (2026-09-08): the harness's event, and its tool when the event has one —
 *  `PreToolUse:Edit`, `PostToolUse:Bash`, `UserPromptSubmit`. Null when the payload names no event. */
export function surfaceOf(p) {
  const ev = typeof p?.hook_event_name === 'string' && p.hook_event_name ? p.hook_event_name : null;
  if (!ev) return null;
  const tool = typeof p?.tool_name === 'string' && p.tool_name ? p.tool_name : null;
  return tool ? `${ev}:${tool}` : ev;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'apply_patch']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'spawn_agent']); // OQ1: Claude Code renamed Task → Agent; Codex serializes spawn_agent (alias Agent)

/** What this fire DOES, from the payload alone (2026-09-08): a serve shape, `commit` (the
 *  PostToolUse:Bash fork on a `git commit`), `epoch`, or null (nothing — silence). */
export function shapeOf(p) {
  const ev = p?.hook_event_name;
  const tool = p?.tool_name;
  if (ev === 'UserPromptSubmit') return 'prompt';
  if (ev === 'PreCompact' || ev === 'SessionStart') return 'epoch';
  if (ev === 'PreToolUse') {
    if (EDIT_TOOLS.has(tool)) return 'edit';
    if (AGENT_TOOLS.has(tool)) return 'task';
    if (tool === 'Bash') return 'bash';
    return null;
  }
  if (ev === 'PostToolUse') {
    if (tool === 'Read') return 'read';
    if (tool === 'Bash') return isGitCommit(p?.tool_input?.command) ? 'commit' : 'bash-post';
    return null;
  }
  return null;
}

/** Build the surface-carrying /api/recon body for a serve shape, or null when the fire has
 *  nothing to say (fail-open silence). Pure — the rig drives it via the spawned script. */
export function buildFire(lane, p) {
  const t = p.tool_input ?? {};
  const branch = branchOf(p.cwd);
  const repoRoot = rootOf(p.cwd);
  const base = {
    surface: surfaceOf(p),
    ...(typeof p.session_id === 'string' && p.session_id ? { session_id: p.session_id } : {}),
    ...(typeof p.prompt_id === 'string' && p.prompt_id ? { prompt_id: p.prompt_id } : {}),
    // measured: absent on main-session fires, present in subagent context — pass through.
    ...(typeof p.agent_id === 'string' && p.agent_id ? { agent_id: p.agent_id } : {}),
    // the checkout's branch, so the since line can say where a write happened when
    // that is not where this terminal stands. Absent when there is none to read (fail-open).
    ...(branch ? { branch } : {}),
    // the repo's root, so the server can DEMAND this branch's chain now, before
    // any transcript of this session is ingested. Absent when there is no repo (fail-open).
    ...(repoRoot ? { repo_root: repoRoot } : {}),
  };
  if (lane === 'edit') {
    if (p.tool_name === 'apply_patch') {
      const spans = extractPatchSpans(String(t.command ?? t.input ?? t.patch ?? ''));
      if (spans.length === 0) return null;
      const code_spans = [];
      for (const s of spans) {
        code_spans.push({ file: s.file, code: '*' });
        if (s.pre) code_spans.push({ file: s.file, code: s.pre });
      }
      return { ...base, code_spans };
    }
    const file = t.file_path;
    if (typeof file !== 'string' || !file) return null;
    const code_spans = [{ file, code: '*' }];
    // Write fires carry no old_string — file scope only, exactly what the unresolved
    // ${tool_input.old_string} template degraded to under foldCodeSpans (parity preserved).
    if (typeof t.old_string === 'string' && t.old_string.length > 0) code_spans.push({ file, code: t.old_string });
    return { ...base, code_spans };
  }
  if (lane === 'task') return typeof t.prompt === 'string' && t.prompt ? { ...base, query: t.prompt } : null;
  if (lane === 'bash') return typeof t.command === 'string' && t.command ? { ...base, query: t.command } : null;
  if (lane === 'prompt') return typeof p.prompt === 'string' && p.prompt ? { ...base, query: p.prompt } : null;
  if (lane === 'read') {
    const file = t.file_path;
    if (typeof file !== 'string' || !file) return null;
    const content = p.tool_response?.file?.content; // measured stdin shape (Read)
    const code_spans = [{ file, code: '*' }];
    if (typeof content === 'string' && content.length > 0) code_spans.push({ file, code: content });
    return { ...base, code_spans };
  }
  if (lane === 'bash-post') {
    const r = p.tool_response ?? {};
    // measured stdin shapes: Claude sends {stdout, stderr} (stderr rides too — test runners
    // put their FAIL lines there); Codex 0.147.0 sends ONE merged plain string. Codex reads
    // files via shell, so this string IS its read lane's substrate.
    const output = typeof r === 'string' ? r : [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x.length > 0).join('\n');
    const q = typeof t.command === 'string' && t.command ? t.command : undefined;
    if (!q && !output) return null;
    return { ...base, ...(q ? { query: q } : {}), ...(output ? { output } : {}) };
  }
  return null;
}

/** A commit counts as "just landed" when HEAD's committer time is within this window of now —
 *  the hook fires right after the command; an older HEAD means the command did not commit
 *  (rejected by a pre-commit hook, nothing to commit, --dry-run). */
const FRESH_COMMIT_S = 300;
/** Past this the diff is not posted (a walk over it would be the skill's "very large commit"
 *  shortcut territory) — the DIRECTIVE goes out instead and the model walks what matters. */
const DIFF_MAX_BYTES = 1_000_000;

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** The checkout branch of the hook's cwd, or null: no cwd, no git, a detached HEAD
 *  (`rev-parse --abbrev-ref` says `HEAD`). One git call, ~5 ms; never throws. */
export function branchOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return b && b !== 'HEAD' ? b.slice(0, 200) : null;
  } catch { return null; }
}

/** The repo's ROOT COMMIT (the anchor is `repo:<root>`; the tray's rule: the
 *  oldest root when histories grafted), or null. The root never changes and the walk to it is
 *  O(history), so it is cached once per checkout at `<git-common-dir>/pathsayer-root` (worktrees
 *  share it). Two cheap git calls on a hit, one long one on the first miss; never throws. */
export function rootOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (!common) return null;
    const cache = join(common, 'pathsayer-root');
    try {
      const hit = readFileSync(cache, 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(hit)) return hit;
    } catch { /* no cache yet */ }
    const roots = git(cwd, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const root = roots[roots.length - 1];
    if (!root || !/^[0-9a-f]{40}$/.test(root)) return null;
    try { writeFileSync(cache, root + '\n'); } catch { /* read-only checkout: no cache, still an answer */ }
    return root;
  } catch { return null; }
}

/** Deep recon on a commit — the fire: `null` = nothing to do (not a commit; no commit landed);
 *  `{ fallback: true }` = a commit landed but its diff is not postable (too large / unreadable)
 *  — emit the DIRECTIVE; otherwise the surface-carrying body with the diff, verbatim. The
 *  surface is the door it came through (PostToolUse:Bash); the diff is what says "walk". */
export function buildCommitFire(p) {
  const t = p.tool_input ?? {};
  if (!isGitCommit(t.command)) return null;
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  let sha, committedAt;
  try {
    const [h, ct] = git(cwd, ['log', '-1', '--format=%H %ct']).trim().split(' ');
    sha = h; committedAt = Number(ct);
  } catch { return null; } // not a repo, or no commits — nothing landed
  if (!sha || !Number.isFinite(committedAt) || Date.now() / 1000 - committedAt > FRESH_COMMIT_S) return null;
  let diff;
  try { diff = git(cwd, ['show', 'HEAD', '-U3', '--format=', '--no-color', '--no-ext-diff']); } catch { return { fallback: true }; }
  if (!diff.trim()) return null; // a merge or an empty commit — nothing to walk
  if (diff.length > DIFF_MAX_BYTES) return { fallback: true };
  const branch = branchOf(cwd);
  const repoRoot = rootOf(cwd);
  return {
    surface: surfaceOf(p),
    // the walk's marks know where the reader stands, and the fire demands the chain
    ...(branch ? { branch } : {}),
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    ...(typeof p.session_id === 'string' && p.session_id ? { session_id: p.session_id } : {}),
    ...(typeof p.prompt_id === 'string' && p.prompt_id ? { prompt_id: p.prompt_id } : {}),
    ...(typeof p.agent_id === 'string' && p.agent_id ? { agent_id: p.agent_id } : {}),
    commit: sha,
    diff,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  // argv is IGNORED (2026-09-08): the payload decides. A running session may still hold a
  // pre-2026-09-08 hooks.json that passes `--lane x "label"`; the behavior must not depend on it.
  const payload = await readStdin().catch(() => ({}));
  const lane = shapeOf(payload);
  if (!lane) return; // an event or tool this adapter has no behavior for — silence
  const origin = resolveOrigin({ baked: await bakedOrigin() });
  const sessionId = (typeof payload.session_id === 'string' && payload.session_id) || 'default';
  if (lane === 'epoch') {
    const ev = payload.hook_event_name;
    if (ev === 'PreCompact' || (ev === 'SessionStart' && payload.source === 'compact')) {
      await bumpEpoch({ origin, sessionId });
    }
    return; // SessionStart(startup) and every other lifecycle fire: deliberately nothing.
  }
  const commit = lane === 'commit';
  // the commit walk's failure shape is the DIRECTIVE, not silence (a commit is never silently
  // unchecked); every other shape fails to silence
  const fallback = () => {
    if (!commit) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: DIRECTIVE } }));
  };
  const fire = commit ? buildCommitFire(payload) : buildFire(lane, payload);
  if (!fire) return;
  if (fire.fallback === true) return fallback();
  const tok = await getBearer({ origin, sessionId });
  if (!tok?.token) return fallback(); // not armed yet — the mint hook arms; the next fire serves
  fire.epoch = readEpoch({ origin, sessionId }); // S3-B: the client-declared counter rides every serve
  let body = null;
  try {
    // declare the plugin build (last-seen per account+harness on the server; the
    // /admin fleet reads it). Absent when harness or version is unknown — never guessed.
    const tag = pluginTag(process.env, payload, await bakedPluginVersion());
    const res = await fetch(`${origin}/api/recon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}`, ...(tag ? { 'x-pathsayer-plugin': tag } : {}) },
      body: JSON.stringify(fire),
      // a walk is seconds, not the serve's sub-second (measured 2026-09-01: 0.4–0.6 s warm on
      // 37–53 nodes after the speed fixes; the absence miner and a large diff can add more)
      signal: AbortSignal.timeout(commit ? 25_000 : 7000),
    });
    // 401 means the grant behind the machine bearer is gone (S0's gate): drop it so
    // the next prompt's mint hook re-arms. Every other failure keeps it — a hiccup is not a revoke.
    if (res.status === 401) { await dropBearer({ origin }); return fallback(); }
    if (!res.ok) return fallback();
    body = await res.json().catch(() => null);
  } catch { return fallback(); /* transport — silent (or the directive), never block the turn */ }
  if (!body?.hookSpecificOutput) return fallback();
  // 2026-08-23 — the statusline sidecar: ours, never the harness's. Used for the bar, then
  // STRIPPED so the stdout envelope stays verbatim (the parity contract below).
  const sidecar = body.pathsayer ?? null;
  if (sidecar) delete body.pathsayer;
  // statusline presence → 2026-08-24 (Gary): EVERY served lane writes the bar from the
  // sidecar (the prompt-only gate retires — the sidecar rides every lane's response and the bar
  // shows files, never attribution text). Silence still paints on the prompt lane only: a dimmed
  // 'silent' on every quiet bash fire would flap the bar. Lazy + fail-open.
  {
    const statusLib = await import(new URL('./lib/status.mjs', import.meta.url)).catch(() => null);
    const text = body.hookSpecificOutput.additionalContext;
    try {
      if (typeof text === 'string' && text.length > 0) statusLib?.writeServe(sessionId, text, { surface: fire.surface, op: commit ? 'walk' : 'serve' }, sidecar);
      else if (lane === 'prompt') statusLib?.writeSilent(sessionId, { surface: 'UserPromptSubmit' });
    } catch { /* presence is best-effort */ }
  }
  process.stdout.write(JSON.stringify(body)); // the envelope, verbatim — the parity contract
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0)); // fail-open: an adapter error must never block the turn
