// 2026-09-10 — what the session REGISTERED, beside what RAN. A harness expands
// CLAUDE_PLUGIN_ROOT once, at session start, to the versioned cache directory of the build it
// registered; the newest build forwards the older builds beside it (self-heal.mjs), so the code
// that runs may be newer than that directory. The running script can see both: its own
// plugin.json (what ran) and the registered root (what the session started on) — and the two
// hooks.json files, whose difference is the one thing a forwarder cannot fix (the harness froze
// the session's EVENT SET too). Three readings, never guessed: null / '' when unknown.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const STAMP = /^\d+\.\d+\.\d+\.\d+$/;

/** The build stamp the session registered — the basename of CLAUDE_PLUGIN_ROOT when it is one;
 *  null when unset, the dev tree, or any other shape. */
export function registeredVersion(env) {
  const root = typeof env.CLAUDE_PLUGIN_ROOT === 'string' ? env.CLAUDE_PLUGIN_ROOT.replace(/[\\/]+$/, '') : '';
  if (root === '') return null;
  const name = basename(root);
  return STAMP.test(name) ? name : null;
}

function hooksHash(root) {
  try { return createHash('sha256').update(readFileSync(join(root, 'hooks', 'hooks.json'))).digest('hex'); } catch { return null; }
}

/** 'same' when the registered hooks.json is byte-equal to the running build's (this session's
 *  event set is current), 'stale' when it differs (a restart would change something), null when
 *  either cannot be read. */
export function hooksState(env, myRoot) {
  const root = typeof env.CLAUDE_PLUGIN_ROOT === 'string' ? env.CLAUDE_PLUGIN_ROOT.replace(/[\\/]+$/, '') : '';
  if (root === '' || typeof myRoot !== 'string' || myRoot === '') return null;
  const mine = hooksHash(myRoot);
  if (mine === null) return null;
  if (resolve(root) === resolve(myRoot)) return 'same';
  const theirs = hooksHash(root);
  if (theirs === null) return null;
  return theirs === mine ? 'same' : 'stale';
}

/** The header tail: `;registered=<v>;hooks=<same|stale>` — nothing without a registered
 *  version (an old server reads the bare form; a rig sets no root), no hooks part without a
 *  state. */
export function pluginSuffix(env, myRoot) {
  const registered = registeredVersion(env);
  if (registered === null) return '';
  const state = hooksState(env, myRoot);
  return `;registered=${registered}${state === null ? '' : `;hooks=${state}`}`;
}
