// THE SERVER-TOLD RELEASE (2026-09-16). Nobody told a running plugin that a newer build existed:
// the harness's own marketplace check is a startup-only background job, a cloud environment is a
// filesystem snapshot, and the plugin never asked. Now every hook reply's sidecar carries
// `plugin: { current, required }` and GET /api/plugin/release answers the same pair to a
// SessionStart. This module DECIDES (pure) and ACTS (a detached child running the harness's own
// verbs); the hook never waits for it, and the next fire simply runs the new build — the hook
// commands resolve the newest installed version at fire time, so no restart is needed for the
// code; a reload is asked for only when the session-start surface changed (registered.mjs).
//
//   current   the public marketplace's own plugin.json version (the cron reads it into KV)
//   required  the operator's floor: below it the update is FORCED — the machine throttle does not
//             apply (once per session instead), and a harness that cannot update is told so once
//
// Only the public marketplace's own cache root (`<cache>/pathsayer/pathsayer/<stamp>/`) and only
// Claude Code harnesses update themselves. A `pathsayer-dev` root (the directory marketplace at
// core/extensions/dev-install), a non-stamp root (the dev tree), a Codex fire (its cache layout and
// CLI verbs are its own) and an unknown harness get one stderr line under `required` and nothing
// otherwise. The runner writes one line per outcome to `<origin dir>/update.log` and a stamp per
// TARGET build (`update-<target>`: started → ok | fail) so a machine tries a build once; a failed
// or unfinished attempt re-arms after six hours.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareStamps, STAMP } from './self-heal.mjs';

export const UPDATE_RETRY_MS = 6 * 60 * 60 * 1000;
export const UPDATE_LOG = 'update.log';
const DEFAULT_TIMEOUT_MS = 90_000;
const MARKETPLACE = 'pathsayer';
const PLUGIN = 'pathsayer@pathsayer';

/** `<cache>/<marketplace>/<marketplace>/<stamp>` → { marketplace, stamp }; anything else null. */
export function marketplaceRootOf(root) {
  if (typeof root !== 'string' || root === '') return null;
  const r = root.replace(/[\\/]+$/, '');
  const stamp = basename(r);
  if (!STAMP.test(stamp)) return null;
  const mp = basename(dirname(r));
  const mp2 = basename(dirname(dirname(r)));
  if (mp === '' || mp !== mp2) return null;
  return { marketplace: mp, stamp };
}

/** 2026-09-21 — EVERY HARNESS UPDATES ITSELF (Gary, 2026-09-18: "why on earth would we only allow
 *  claude code to auto update, that was a bad decision"). Which VERBS a harness updates through:
 *  Claude Code and Claude Code Cloud through `claude`'s (a cloud environment is a filesystem
 *  snapshot nobody else refreshes — the laptop's rule applies); Codex and Codex Cloud through
 *  `codex`'s own — its marketplace refresh and its install verb, the same verb the cloud's setup
 *  script runs — never by spawning `claude`. An unknown harness has none. */
export function verbsFor(harness) {
  if (harness === 'claude-code' || harness === 'claude-code-cloud') return 'claude';
  if (harness === 'codex' || harness === 'codex-cloud') return 'codex';
  return null;
}
const VERBS = {
  claude: { marketplace: ['plugin', 'marketplace', 'update', MARKETPLACE], update: ['plugin', 'update', PLUGIN, '-y', '--json'], line: `claude plugin update ${PLUGIN}` },
  codex: { marketplace: ['plugin', 'marketplace', 'upgrade', MARKETPLACE], update: ['plugin', 'add', PLUGIN], line: `codex plugin marketplace upgrade ${MARKETPLACE} && codex plugin add ${PLUGIN}` },
};
const noticeLine = (running, required, verbs = 'claude') => `plugin ${running} is behind ${required}; run \`${(VERBS[verbs] ?? VERBS.claude).line}\`.`;

/** The decision, pure: null (nothing), { target, forced[, verbs] } (update to target — `verbs`
 *  names the harness's own verbs when they are not Claude's), or { notice } (a harness or root that
 *  cannot update itself, below the floor). */
export function decideUpdate({ running, current, required, root, harness }) {
  const cur = typeof current === 'string' && STAMP.test(current) ? current : null;
  const req = typeof required === 'string' && STAMP.test(required) ? required : null;
  const run = typeof running === 'string' && STAMP.test(running) ? running : null;
  if (run === null || (cur === null && req === null)) return null;
  const belowFloor = req !== null && compareStamps(run, req) < 0;
  const mp = marketplaceRootOf(root);
  const verbs = verbsFor(harness);
  const canUpdate = verbs !== null && mp !== null && mp.marketplace === MARKETPLACE;
  if (!canUpdate) return belowFloor ? { notice: noticeLine(run, req, verbs ?? 'claude') } : null;
  const behind = cur !== null && compareStamps(run, cur) < 0;
  if (behind) return { target: cur, forced: belowFloor, ...(verbs === 'claude' ? {} : { verbs }) };
  if (belowFloor) return { notice: noticeLine(run, req, verbs) }; // a floor above what the marketplace serves: nothing to install
  return null;
}

const stampPath = (dir, target) => join(dir, `update-${target}`);

function readStamp(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return s && typeof s === 'object' && typeof s.at === 'number' && typeof s.outcome === 'string' ? s : null;
  } catch { return null; }
}

/** 'fresh' when this machine may try `target` now; 'held' when it already did (ok holds forever;
 *  a fail or an unfinished start re-arms after UPDATE_RETRY_MS). */
export function throttleState({ originDir, target, nowMs = Date.now() }) {
  const s = readStamp(stampPath(originDir, target));
  if (s === null) return 'fresh';
  if (s.outcome === 'ok') return 'held';
  return nowMs - s.at > UPDATE_RETRY_MS ? 'fresh' : 'held';
}

/** Spawn the detached runner for `target`. Returns the child, or null when held (the machine
 *  stamp; or, forced, the session stamp). Never throws. */
export function spawnUpdater({ target, running, originDir, stateDir, forced = false, verbs = 'claude', env = process.env, nowMs = Date.now() }) {
  try {
    if (forced) {
      if (typeof stateDir === 'string' && stateDir !== '') {
        const once = join(stateDir, `update-required-${target}`);
        if (existsSync(once)) return null;
        try { writeFileSync(once, `${new Date(nowMs).toISOString()}\n`); } catch { /* best-effort */ }
      }
    } else if (throttleState({ originDir, target, nowMs }) === 'held') return null;
    const stamp = stampPath(originDir, target);
    try { mkdirSync(originDir, { recursive: true }); } catch { /* exists */ }
    writeFileSync(stamp, JSON.stringify({ at: nowMs, outcome: 'started', from: running ?? null }));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--target', target, '--from', String(running ?? '?'), '--log', join(originDir, UPDATE_LOG), '--stamp', stamp, '--verbs', verbs], {
      detached: true, stdio: 'ignore', env,
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

// ── the runner (a child: `node self-update.mjs --target … --from … --log … --stamp …`) ───────────
const ptTime = (d = new Date()) => `${d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })} PT`;

function runVerb(bin, argv, timeoutMs) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM')) return { ok: false, why: 'timeout' };
  if (r.error) return { ok: false, why: r.error.code === 'ENOENT' ? `${bin} not on PATH` : String(r.error.message || r.error.code) };
  if (r.status === 0) return { ok: true, why: '' };
  const first = String(r.stderr || r.stdout || '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? `exit ${r.status}`;
  return { ok: false, why: first };
}

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

function runnerMain(argv) {
  const target = argOf(argv, '--target');
  const from = argOf(argv, '--from') ?? '?';
  const log = argOf(argv, '--log');
  const stamp = argOf(argv, '--stamp');
  if (!target || !log) return;
  const timeoutMs = Number(process.env.PATHSAYER_UPDATE_TIMEOUT_MS) > 0 ? Number(process.env.PATHSAYER_UPDATE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const line = (s) => { try { appendFileSync(log, `${ptTime()} ${from} → ${target} ${s}\n`); } catch { /* nowhere to write */ } };
  // 2026-09-21 — the harness's OWN verbs (`--verbs codex` for a Codex fire); `claude` is the default
  const bin = argOf(argv, '--verbs') === 'codex' ? 'codex' : 'claude';
  const v = VERBS[bin];
  const m = runVerb(bin, v.marketplace, timeoutMs);
  line(m.ok ? 'marketplace ok' : `marketplace fail(${m.why})`);
  const u = runVerb(bin, v.update, timeoutMs);
  line(u.ok ? 'update ok' : `update fail(${u.why})`);
  if (stamp) { try { writeFileSync(stamp, JSON.stringify({ at: Date.now(), outcome: u.ok ? 'ok' : 'fail', from })); } catch { /* best-effort */ } }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--target')) {
  try { runnerMain(process.argv.slice(2)); } catch { /* fail-open */ }
  process.exitCode = 0;
}
