// 2026-09-10 — what the session REGISTERED, beside what RAN. A harness expands
// CLAUDE_PLUGIN_ROOT once, at session start, to the versioned cache directory of the build it
// registered; the newest build forwards the older builds beside it (self-heal.mjs), so the code
// that runs may be newer than that directory. The running script can see both: its own
// plugin.json (what ran) and the registered root (what the session started on).
//
// 2026-09-16 — the bit reads the SESSION-START SURFACE. The harness loads three things from the
// registered directory at session start and never again: the hooks.json EVENT SET (event names
// and matchers — never its description, never its command strings, which resolve the newest
// installed build at fire time), `.mcp.json`, and every file under `skills/`. Those are what a
// reload (or a restart) changes; nothing else in the directory is. Until today the compare was
// hooks.json's bytes: a description-only edit said "stale", a skill-only or MCP-only release said
// "same" (measured on a laptop between 1.0.20260910.5 and 1.0.20260915.21: all three differed).
// And the reload notice is once per FROZEN ROOT: `notice=due` rides the suffix while the surface
// is stale and the registered root carries no `.reload-noticed` marker; the prompt fire that
// spoke the line stamps it. The marker lives in the registered directory because that directory
// IS the reason — the moment the session reloads it is registered no more. Three readings, never
// guessed: null / '' when unknown.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const STAMP = /^\d+\.\d+\.\d+\.\d+$/;
export const NOTICE_MARKER = '.reload-noticed';
/** The surfaces, in the order the wire names them. */
export const SURFACES = ['events', 'mcp', 'skills'];

function registeredRoot(env) {
  const root = typeof env.CLAUDE_PLUGIN_ROOT === 'string' ? env.CLAUDE_PLUGIN_ROOT.replace(/[\\/]+$/, '') : '';
  return root === '' ? null : root;
}

/** The build stamp the session registered — the basename of CLAUDE_PLUGIN_ROOT when it is one;
 *  null when unset, the dev tree, or any other shape. */
export function registeredVersion(env) {
  const root = registeredRoot(env);
  if (root === null) return null;
  const name = basename(root);
  return STAMP.test(name) ? name : null;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** The EVENT SET of a hooks.json: `{ event: [matcher…] }`, events and matchers sorted — the
 *  description and every command string left out. null when unreadable or not our shape. */
function eventSetOf(root) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')); } catch { return null; }
  const hooks = parsed && typeof parsed === 'object' ? parsed.hooks : null;
  if (!hooks || typeof hooks !== 'object') return null;
  const out = {};
  for (const ev of Object.keys(hooks).sort()) {
    const entries = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    out[ev] = entries.map((e) => (e && typeof e.matcher === 'string' ? e.matcher : '')).sort();
  }
  return JSON.stringify(out);
}

/** Every regular file under `dir`, hashed with its relative path; '' when the dir is absent. */
function treeHash(dir) {
  if (!existsSync(dir)) return '';
  const lines = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, `${rel}${n}/`);
      else if (st.isFile()) { try { lines.push(`${rel}${n}\n${sha(readFileSync(p))}`); } catch { /* unreadable: left out */ } }
    }
  };
  walk(dir, '');
  return lines.join('\n');
}

/** The session-start surface of a plugin directory: null when its hooks.json cannot be read. */
function surfaceOf(root) {
  const events = eventSetOf(root);
  if (events === null) return null;
  let mcp = '';
  try { mcp = readFileSync(join(root, '.mcp.json'), 'utf8'); } catch { mcp = ''; }
  return { events: sha(events), mcp: sha(mcp), skills: sha(treeHash(join(root, 'skills'))) };
}

/** Which surfaces differ between the registered root and the running build: [] when none (or the
 *  same directory), a subset of SURFACES in that order, null when either side cannot be read. */
export function surfaceDiff(env, myRoot) {
  const root = registeredRoot(env);
  if (root === null || typeof myRoot !== 'string' || myRoot === '') return null;
  const mine = surfaceOf(myRoot);
  if (mine === null) return null;
  if (resolve(root) === resolve(myRoot)) return [];
  const theirs = surfaceOf(root);
  if (theirs === null) return null;
  return SURFACES.filter((k) => theirs[k] !== mine[k]);
}

/** 'same' when the registered root's session-start surface equals the running build's, 'stale'
 *  when it differs (a reload would change something), null when either cannot be read. */
export function hooksState(env, myRoot) {
  const diff = surfaceDiff(env, myRoot);
  return diff === null ? null : diff.length === 0 ? 'same' : 'stale';
}

/** The marker's path in the REGISTERED root; null without one. */
export function noticeMarker(env) {
  const root = registeredRoot(env);
  return root === null ? null : join(root, NOTICE_MARKER);
}

/** 'due' while stale and unstamped, 'told' when stale and stamped, null when same or unknown. */
export function noticeState(env, myRoot) {
  const state = hooksState(env, myRoot);
  if (state !== 'stale') return null;
  const marker = noticeMarker(env);
  return marker !== null && existsSync(marker) ? 'told' : 'due';
}

/** Stamp the registered root: the line was spoken for it. true when written. Never throws. */
export function stampNoticed(env, { ran } = {}) {
  const marker = noticeMarker(env);
  if (marker === null) return false;
  try { writeFileSync(marker, `${new Date().toISOString()} by ${typeof ran === 'string' ? ran : '?'}\n`); return true; } catch { return false; }
}

/** The header tail: `;registered=<v>;hooks=<same|stale>[;notice=due;changed=<a-b-c>]` — nothing
 *  without a registered version (an old server reads the bare form; a rig sets no root), no hooks
 *  part without a state, the notice pair only while due (with what differs, hyphen-joined). */
export function pluginSuffix(env, myRoot) {
  const registered = registeredVersion(env);
  if (registered === null) return '';
  const diff = surfaceDiff(env, myRoot);
  if (diff === null) return `;registered=${registered}`;
  if (diff.length === 0) return `;registered=${registered};hooks=same`;
  const due = noticeState(env, myRoot) === 'due';
  return `;registered=${registered};hooks=stale${due ? `;notice=due;changed=${diff.join('-')}` : ''}`;
}
