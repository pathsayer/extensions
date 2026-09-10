// DEEP RECON ON A COMMIT — the shared module (2026-07-22 → re-cut 2026-09-01 → 2026-09-08). Two exports: `isGitCommit` (is this bash command a real `git commit`?) and the
// fallback DIRECTIVE.
//
// Until 2026-09-01 this file was itself the PreToolUse:Bash hook: it injected the DIRECTIVE and
// the MODEL gathered the diff and called recon_walk with it, because "a hook can template
// ${tool_input.command} but cannot run git diff to carry the actual diff". That was true of a
// templated hook and false once the adapter (recon-hook.mjs) became a node script. The walk now
// rides that adapter on PostToolUse:Bash: when the command was a `git commit` and a commit has
// just landed, the adapter runs `git show HEAD -U3` itself and posts the diff; the server walks it
// (the same recon_walk the MCP op runs) and answers the header + checks. The model never carries
// the diff (Gary: "pasting 13–16 KB escaped diff"), and the ledger row rides the session id. The
// DIRECTIVE survives as the FALLBACK — served when the walk cannot be (not armed, server down, a
// very large diff) so a commit is never silently unchecked. ADVISORY throughout: nothing here
// ever blocks a commit.
//
// Renamed 2026-09-08: the old name was a synonym for recon and a clash with a competitor's git-hook
// product. There is one skill (recon) and this is its recipe run on the commit — "deep recon on a
// commit".
import { resolve } from 'node:path';

/** True if `cmd` runs `git commit` as a real subcommand (not --help), in any &&/;/| segment. Skips
 *  git's global flags (`-C <path>`, `-c k=v`) before reading the subcommand. */
export function isGitCommit(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const s = seg.trim();
    const toks = s.split(/\s+/);
    let i = 0;
    if (toks[i] !== 'git') continue;
    i++;
    while (i < toks.length && toks[i].startsWith('-')) { i += toks[i] === '-C' || toks[i] === '-c' ? 2 : 1; }
    if (toks[i] === 'commit' && !s.includes('--help') && !/ -h(\s|$)/.test(s)) return true;
  }
  return false;
}

/** A literal shell word: quotes stripped; null when the shell would expand it (a variable, a
 *  substitution, a glob, `~`) or it is empty — the adapter never guesses what the shell did. */
function literalWord(w) {
  if (typeof w !== 'string' || w === '') return null;
  if (/[$`*?~]/.test(w)) return null;
  const m = /^'([^']*)'$/.exec(w) ?? /^"([^"]*)"$/.exec(w);
  return m ? m[1] : w;
}

/** The directory a shell command WORKS in, resolved from the command the way `commitDirOf` resolves
 *  a commit's: a leading `cd <dir>` / `pushd <dir>` chain (literal words only; a variable, a
 *  substitution or `cd -` is unresolvable → null), and a `git -C <dir>` on any git segment. Null
 *  when the command names no directory of its own — the caller's cwd is the answer then. Used by
 *  the fire to name the checkout a Bash command writes under (cwd + this), never to read HEAD. */
export function cdTargetOf(cmd, cwd) {
  if (typeof cmd !== 'string' || !cmd || typeof cwd !== 'string' || !cwd) return null;
  let dir = cwd;
  let named = false;
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const s = seg.trim().replace(/^\(+\s*/, '').replace(/\s*\)+$/, '');
    const toks = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    if (toks[0] === 'cd' || toks[0] === 'pushd') {
      const target = toks[1];
      if (target === undefined) return null;
      const lit = literalWord(target);
      if (lit === null || lit === '-') return null;
      dir = resolve(dir, lit);
      named = true;
      continue;
    }
    if (toks[0] !== 'git') continue;
    let i = 1;
    let at = dir;
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-C') {
        const lit = literalWord(toks[i + 1]);
        if (lit === null) return null;
        at = resolve(at, lit);
        named = true;
        i += 2;
      } else i += toks[i] === '-c' ? 2 : 1;
    }
    if (at !== dir) return at;
  }
  return named && dir !== cwd ? dir : null;
}

/** The directory the command's `git commit` ran in, resolved from the COMMAND (2026-09-08, another
 *  thread's review of 143): a preceding `cd <dir>` (chains compose), the matching segment's `-C
 *  <dir>` (several compose, as git composes them; relative to the cd'd directory), a subshell's
 *  parens. `cwd` is where the shell started. Null when there is no commit or a target cannot be
 *  resolved (a variable, a substitution, `cd -`) — the caller falls back to the directive rather
 *  than read HEAD in a directory the command never named: in a shared checkout with worktrees the
 *  hook's cwd is another tab's repository, and its fresh commit would walk as this session's. */
export function commitDirOf(cmd, cwd) {
  if (!isGitCommit(cmd) || typeof cwd !== 'string' || !cwd) return null;
  let dir = cwd;
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    const s = seg.trim().replace(/^\(+\s*/, '').replace(/\s*\)+$/, '');
    // a quoted word is one token: split on whitespace outside quotes
    const toks = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    if (toks[0] === 'cd' || toks[0] === 'pushd') {
      const target = toks[1];
      if (target === undefined) return null; // `cd` alone is $HOME — not resolved here
      const lit = literalWord(target);
      if (lit === null || lit === '-') return null;
      dir = resolve(dir, lit);
      continue;
    }
    if (toks[0] !== 'git') continue;
    let i = 1;
    let at = dir;
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-C') {
        const lit = literalWord(toks[i + 1]);
        if (lit === null) return null;
        at = resolve(at, lit);
        i += 2;
      } else i += toks[i] === '-c' ? 2 : 1;
    }
    if (toks[i] === 'commit' && !s.includes('--help') && !/ -h(\s|$)/.test(s)) return at;
  }
  return null;
}

// 2026-08-29 — the directive names recon_walk with the diff (the
// pre-walk op is retired; the skill holds the checks). Timing stays honest: the walk runs WITH
// the commit (a finding means amend the message or fix in a follow-up), never ahead of it — since
// 2026-09-01 on PostToolUse, once it has landed. 2026-08-31 — the walk is KEPT under
// its handle and read by an op, so the directive teaches the loop, not a script: walk the diff,
// read the checks in-band, query the kept graph by the `rcn_` in the header with recon_walk_query.
// Exported so the test pins the words.
export const DIRECTIVE =
  'Pathsayer deep recon on a commit (advisory; the commit is not blocked). You just ran git commit. ' +
  'Run the recon skill\'s deep-recon recipe on this change: get the diff (`git show HEAD -U3` for the ' +
  'commit that just landed, or `git diff <base>..<head> -U3` for the branch range) and call the ' +
  'Pathsayer `recon_walk` op with it ({ diff: "<the diff, verbatim>" }). The response is the header ' +
  '(`walked … · rcn_…`) and the `checks` lists; the graph itself is kept under that rcn_ — read it ' +
  'with `recon_walk_query` ({ rcn, verb }: now <id> · node <id> · candidates <a> <b> · grep · top · ' +
  'origins · arc). Run the three checks: replaced (`node` the ids above the mass floor, ten at most in ' +
  'one call — does the change undo recorded reasoning without the message saying so? a mostly-replaced ' +
  'attribution\'s current form is `verb: "now"`), overlaps ' +
  '(does the diff pick a side of an unsettled pair? a pair beyond the served list is `verb: ' +
  '"candidates"`), and absences (files that usually change with these did not — make the edit or ' +
  'name in one clause why not). Raise a conflict to the user with the receipt (the attribution\'s ' +
  'verbatim intent, its atr_ id and the walk\'s rcn_, the conflicting diff line) — amend the message ' +
  'or fix in a follow-up. Hunks under `newGround` have no recorded reason; say that, never invent ' +
  'one. If nothing conflicts, say "Deep recon checks are clean."';
