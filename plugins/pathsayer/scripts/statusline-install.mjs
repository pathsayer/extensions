#!/usr/bin/env node
// Pathsayer statusline INSTALL/HEAL hook (ratified 2026-08-19). Runs on
// SessionStart. The plugin manifest cannot register a statusLine (the main status line is
// user-settings-only — verified against the plugins-reference schema 2026-08-19), so this hook
// is the docs-sanctioned wiring: it puts the plugin's statusline.sh into the ACTIVE profile's
// settings.json, once, and keeps the path current across plugin-root moves. Four states, and
// the user always wins:
//
//   1. OURS present            → heal the command path if the plugin root moved; refresh marker.
//   2. absent, NO marker       → first install: write the block + the marker.
//   3. absent, marker present  → the user DELETED it after we installed. That is the opt-out,
//                                and it sticks — never resurrect, never nag. (Opt back in:
//                                delete <config-dir>/pathsayer/statusline-installed.json, or
//                                point /statusline at the script yourself.)
//   4. someone ELSE's statusLine → hands off unconditionally, marker or not.
//
// The marker lives OUTSIDE settings.json (per-profile: <config-dir>/pathsayer/
// statusline-installed.json) so deleting the block cannot delete the memory of the opt-out —
// and gary2 opting out never opts gary out. Fail-open at every layer: any error leaves
// settings untouched and never blocks the session.
//
// The settings write is IN PLACE, deliberately NOT tmp+rename: a rename swaps the inode and
// EVADES Claude Code's settings watcher, so the bar waits for a restart — measured live
// 2026-08-19 (block present for 20+ minutes, never painted; one in-place rewrite of identical
// bytes and it appeared at the next interaction). In-place is seen by the watcher and the
// statusline hot-reloads — install → bar, same session, no restart. The torn-write window on
// a small JSON is the trade, and it is the same one Claude Code's own settings writes make.
//
// BUT the installing session itself does not see that write (measured 2026-08-21, first
// session in a fresh ~/.claude-gary3 tree): SessionStart hooks run before the new session's
// settings watcher is attached, so the first-install write lands in the blind spot and the
// bar waits for a restart — while an identical in-place rewrite minutes later painted it at
// the next interaction. So after a write, a DETACHED re-touch (same bytes, in place, after
// RETOUCH_DELAY_MS) fires once the watcher is up. Idempotent, fail-open, and harmless for
// any other running session in the tree (it re-reads the same settings it already has).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healQuietly } from './lib/self-heal.mjs'; // a frozen session runs current code: forward the older builds beside this one
healQuietly(import.meta.url);
import { homedir } from 'node:os';
import process from 'node:process';
import { detectHarness } from './lib/hookauth.mjs';

/** The hook payload on stdin (Claude and Codex both send one). Empty or malformed → {}. */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** Ours = any pathsayer statusline.sh, whatever root it was installed from. */
export function isOurCommand(command) {
  return typeof command === 'string' && /pathsayer[^"]*\/scripts\/statusline\.sh$/.test(command);
}

/** The four-state decision, pure: returns the settings object to write, or null for no-op. */
export function decide(settings, markerExists, scriptPath) {
  const block = { type: 'command', command: scriptPath, padding: 0 };
  const cur = settings['statusLine'];
  if (cur !== undefined && cur !== null) {
    if (!isOurCommand(cur.command)) return null; // (4) theirs — hands off
    if (cur.command === scriptPath) return null; // (1) ours, current — nothing to do
    return { ...settings, statusLine: { ...cur, command: scriptPath } }; // (1) ours, stale root — heal
  }
  if (markerExists) return null; // (3) deleted after install — the opt-out, respected forever
  return { ...settings, statusLine: block }; // (2) first install
}

/** How long after the install write to re-touch settings.json: past the SessionStart →
 *  watcher-attach gap, short enough that the bar appears during the user's first prompt. */
export const RETOUCH_DELAY_MS = 8000;

/** Rewrite `path` in place with its own current bytes — the watcher-visible no-op. */
export const RETOUCH_SRC =
  "const fs=require('node:fs');const p=process.argv[1];const d=+process.argv[2];" +
  'setTimeout(()=>{try{const b=fs.readFileSync(p);const f=fs.openSync(p,"r+");' +
  'fs.writeSync(f,b,0,b.length,0);fs.ftruncateSync(f,b.length);fs.closeSync(f)}catch{}},d)';

/** Spawn the detached re-touch. Returns the child (tests); never throws. */
export function scheduleRetouch(settingsPath, delayMs = RETOUCH_DELAY_MS) {
  try {
    const child = spawn(process.execPath, ['-e', RETOUCH_SRC, settingsPath, String(delayMs)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

async function main() {
  try {
    // 2026-09-04: CLAUDE CODE ONLY. Codex runs this same hooks.json, and without a
    // gate the heal state (1) re-pointed the CLAUDE status line at the CODEX plugin cache — a path that
    // changes on every Codex plugin version (measured live on ~/.claude/settings.json). Codex has no
    // plugin-drivable status line (2026-08-21 investigation), so the right behavior there is nothing.
    // Harness comes from the PAYLOAD, the same seam mint and the recon adapter use: Codex inherits the
    // parent env, so env alone would mislabel it. Unknown → nothing; never guess a surface.
    const payload = await readStdin().catch(() => ({}));
    if (detectHarness(process.env, payload).harness !== 'claude-code') return;

    const configDir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    const markerPath = join(configDir, 'pathsayer', 'statusline-installed.json');
    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'statusline.sh');
    if (!existsSync(settingsPath) || !existsSync(scriptPath)) return;

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const next = decide(settings, existsSync(markerPath), scriptPath);
    if (next === null) return;

    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n'); // in-place — see header
    scheduleRetouch(settingsPath); // the installing session's own watcher is not up yet — see header
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ installed_at: new Date().toISOString(), command: scriptPath }, null, 2) + '\n');
  } catch {
    // fail-open: presence wiring must never break a session
  }
}

// Direct-execution guard (the 2026-07 nudge lesson): importing this module must not touch
// the filesystem or hang on stdin.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
