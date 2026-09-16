// The checkout helpers the recon adapter and the cloud courier SHARE (2026-09-15; moved here
// from recon-hook.mjs, verbatim, so the courier's anchor is the adapter's anchor by construction:
// `repo:<root commit>`, the oldest root when histories grafted, cached at <git-common-dir>/
// pathsayer-root). Every helper is fail-open: no cwd, no git, no repo → null, never a throw.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** The checkout branch of the hook's cwd, or null: no cwd, no git, a detached HEAD
 *  (`rev-parse --abbrev-ref` says `HEAD`). One git call, ~5 ms; never throws. */
export function branchOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return b && b !== 'HEAD' ? b.slice(0, 200) : null;
  } catch { return null; }
}

/** the shallow-clone rule, 2026-09-16 (R1) — the root cache's name. v2 is written ONLY under a full clone; the v1
 *  file (`pathsayer-root`) may hold a shallow clone's depth boundary (measured in Claude Code Web:
 *  d37181a6… cached and declared for 991464ee…) and is never read again — every cache poisoned
 *  before this rule is ignored without a sweep. A repo can be deepened, never re-shallowed, so
 *  "never write under shallow" is sufficient going forward. */
const ROOT_CACHE = 'pathsayer-root-v2';
const HEX40 = /^[0-9a-f]{40}$/;
const UNKNOWN = Object.freeze({ root: null, known: true, boundary: null });

/** the shallow-clone rule (R1) — the repo's ROOT COMMIT and whether this checkout can KNOW it. `known: false` only
 *  under a shallow clone (`rev-parse --is-shallow-repository`), where `rev-list --max-parents=0`
 *  returns the depth BOUNDARY as if it were parentless — that sha rides as `boundary` (a commit
 *  the clone does hold; the server may resolve from it) and never as the root. No git, not a
 *  repo → root null, known true (nothing was withheld). The shallow check runs BEFORE the cache is
 *  read or written. Never throws. */
export function rootStateOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return UNKNOWN;
  try {
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (!common) return UNKNOWN;
    const parentless = () => git(cwd, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
      const b = parentless();
      const boundary = b[b.length - 1];
      return { root: null, known: false, boundary: boundary && HEX40.test(boundary) ? boundary : null };
    }
    const cache = join(common, ROOT_CACHE);
    try {
      const hit = readFileSync(cache, 'utf8').trim();
      if (HEX40.test(hit)) return { root: hit, known: true, boundary: null };
    } catch { /* no cache yet */ }
    // the oldest root when histories grafted (the tray's rule); O(history) once, then the cache
    const roots = parentless();
    const root = roots[roots.length - 1];
    if (!root || !HEX40.test(root)) return UNKNOWN;
    try { writeFileSync(cache, root + '\n'); } catch { /* read-only checkout: no cache, still an answer */ }
    return { root, known: true, boundary: null };
  } catch { return UNKNOWN; }
}

/** The repo's ROOT COMMIT (the anchor is `repo:<root>`), or null — null under a shallow clone
 *  too (the shallow-clone rule (R1)): a caller that must say WHY reads `rootStateOf`. */
export function rootOf(cwd) {
  return rootStateOf(cwd).root;
}

/** The repo's display name, the tray's rule (crawler resolver.rs `repo_display_name`): `org/repo`
 *  parsed from the origin remote — scp-style `git@host:org/repo` normalized, `.git` dropped —
 *  else the checkout's basename. Null only when `dir` is not a repo at all. Never throws. */
export function displayNameOf(dir) {
  const top = toplevelOf(dir);
  if (top === null) return null;
  try {
    const url = git(dir, ['remote', 'get-url', 'origin']).trim();
    const norm = url.replace(/\.git$/, '').replace(/:/g, '/');
    const segs = norm.split('/').filter(Boolean);
    if (segs.length >= 2) return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`.slice(0, 256);
  } catch { /* no remote */ }
  const base = top.split(/[\\/]/).filter(Boolean).pop();
  return base ? base.slice(0, 256) : null;
}

/** The checkout root (git's toplevel; in a linked worktree, the worktree's own root) of a
 *  directory, or null: no git, not a repo. One git call; never throws. */
export function toplevelOf(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel']).trim();
    return top || null;
  } catch { return null; }
}

