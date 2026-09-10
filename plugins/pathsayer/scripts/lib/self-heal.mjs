// A FROZEN SESSION RUNS CURRENT CODE (2026-09-10). A harness captures a session's hook commands
// once, at session start, and never re-reads them. A command from a build before 2026-09-08 is a
// FIXED PATH into that build's cache directory (`…/pathsayer/pathsayer/1.0.20260902.3/scripts/
// recon-hook.mjs`); a command from 2026-09-08 on resolves the newest installed version at fire
// time. Either way the harness keeps the old directory on disk after an update — which is exactly
// why a frozen session keeps firing at all, and exactly the lever: the file at that path is OURS.
//
// So the newest build, on load, forwards the older builds beside it: each older version's entry
// files become two-line forwarders that resolve the newest installed version and run its entry of
// the same name. From then on a session frozen on any older build runs current hook logic, and the
// version it reports is the build that ran (the entry reads its own plugin.json). The one thing a
// forwarder cannot change is the session's EVENT SET — the harness froze that list too; a new hook
// event needs a restart, and the registered-vs-ran versions on the wire are what show who is behind.
//
// Guards: only OLDER siblings; only files that are ours (they carry the word); never a forwarder
// twice (the header line names it); an atomic write; a marker per healed sibling so the steady
// cost is one stat; and a forwarder whose newest is ITSELF (the current build uninstalled from
// under it) exits 0 — fail-open, never a spawn loop. Every entry calls `healSiblings` first and
// swallows anything it throws: healing must never cost a fire.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The build stamp: `1.0.<yyyymmdd>.<n>` — numeric per segment, `.10` above `.9`. */
export const STAMP = /^\d+\.\d+\.\d+\.\d+$/;
export function compareStamps(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The entry files a frozen session can reach: the three hook commands and the status line the
 *  installer wired by absolute path. Nothing else in a version directory is read by a running
 *  session except through these (their libs and plugin.json resolve relative to the REAL file). */
export const ENTRIES = ['scripts/recon-hook.mjs', 'scripts/mint.mjs', 'scripts/statusline-install.mjs', 'scripts/statusline.sh'];
export const MARKER = '.forwarded';
const FORWARDER_MARK = 'pathsayer forwarder';

/** The .mjs forwarder — self-contained (its own resolver, no import from the old lib), spawns the
 *  newest entry with this fire's argv and stdin so the entry's own `main()` runs exactly as if the
 *  harness had called it; the child inherits CLAUDE_PLUGIN_ROOT (the REGISTERED version). */
export function forwarderMjs() {
  return [
    `// ${FORWARDER_MARK} — this build's hooks were superseded on this machine; the newest installed version runs (a`,
    '// frozen session runs current code). Resolved at every fire, by version order, never by mtime.',
    "import { readdirSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url'; import { basename, dirname, join } from 'node:path';",
    'const me = fileURLToPath(import.meta.url); const versions = dirname(dirname(dirname(me)));',
    "const isStamp = (n) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(n); const num = (n) => n.split('.').map(Number);",
    'const newest = readdirSync(versions).filter(isStamp).sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }).pop();',
    "const target = newest === undefined ? me : join(versions, newest, 'scripts', basename(me));",
    'if (target === me) process.exit(0); // the build that superseded this one is gone: fail-open, never a loop',
    "const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });",
    'process.exit(r.status ?? 1);',
    '',
  ].join('\n');
}

/** The status-line forwarder: the same resolver in sh; `exec` keeps stdin (the harness's JSON). */
export function forwarderSh() {
  return [
    '#!/bin/sh',
    `# ${FORWARDER_MARK} — this build's status line was superseded on this machine; the newest installed version runs`,
    'd="$(cd "$(dirname "$0")/../.." && pwd)"; n="$(ls "$d" | grep -E \'^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$\' | sort -t. -k3,3n -k4,4n | tail -1)"',
    't="$d/$n/scripts/statusline.sh"; [ -f "$t" ] || exit 0',
    '[ "$(cd "$(dirname "$t")" && pwd)" = "$(cd "$(dirname "$0")" && pwd)" ] && exit 0',
    'exec sh "$t"',
    '',
  ].join('\n');
}

export function isForwarder(text) {
  return text.includes(FORWARDER_MARK);
}
/** Ours = the file names the product; a foreign file at one of our paths is never touched. */
export function isOurs(text) {
  return /pathsayer/i.test(text);
}

function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Forward every OLDER sibling of the version directory that holds `entryFileUrl`. Returns what it
 * did, for the tests and for a log line. Pure filesystem; throws nothing it can catch.
 *   { version, siblings: [{ version, forwarded: string[] | 'already' | 'newer' }] }
 */
export function healSiblings(entryFileUrl) {
  const me = fileURLToPath(entryFileUrl);
  const myDir = dirname(dirname(me)); // <versions>/<mine>
  const mine = basename(myDir);
  const versions = dirname(myDir);
  const out = { version: mine, siblings: [] };
  if (!STAMP.test(mine)) return out; // the dev tree (a plugin directory, no version siblings) — nothing to heal
  let names = [];
  try { names = readdirSync(versions).filter((n) => STAMP.test(n) && n !== mine); } catch { return out; }
  for (const v of names) {
    if (compareStamps(v, mine) > 0) { out.siblings.push({ version: v, forwarded: 'newer' }); continue; }
    const dir = join(versions, v);
    if (existsSync(join(dir, MARKER))) { out.siblings.push({ version: v, forwarded: 'already' }); continue; }
    const forwarded = [];
    for (const rel of ENTRIES) {
      const p = join(dir, rel);
      if (!existsSync(p)) continue;
      let text = '';
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      if (!isOurs(text) || isForwarder(text)) continue;
      try { atomicWrite(p, rel.endsWith('.sh') ? forwarderSh() : forwarderMjs()); forwarded.push(rel); } catch { /* read-only: this one stays as it was */ }
    }
    try { writeFileSync(join(dir, MARKER), `${new Date().toISOString()} by ${mine}\n`); } catch { /* the next fire tries again */ }
    out.siblings.push({ version: v, forwarded });
  }
  return out;
}

/** The entry-side call: never throws, never costs more than the readdir. */
export function healQuietly(entryFileUrl) {
  try { return healSiblings(entryFileUrl); } catch { return null; }
}
