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

