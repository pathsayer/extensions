#!/usr/bin/env node
// Pathsayer MINT hook (re-grounded 2026-09-02; the directive retired 2026-09-15). Runs on
// UserPromptSubmit. When this machine holds no client token by any rung of the ladder — the
// signed-in tray's file, PATHSAYER_TOKEN, a cached bearer — it tells the USER so, in one plain line,
// once per machine. It asks nothing of the model.
//
// Until 2026-09-15 it also staged a single-use ticket and injected a directive telling the model
// to call the `mint_client_token` op with it (the only Pathsayer-trusted credential a hook could
// reach was the connector grant, and only the model could present it). Two things ended that: the
// tray now mints and writes the token for the machine, and the plugin's MCP entry is a local proxy
// through which the op has no principal to mint for. A system reminder asking the model to take an
// authentication step is also the exact pattern Codex's and Claude's classifiers flag (measured on
// the 2026-09-13 onboardings). The op and the redeem route stay on the server for plugins that have
// not updated, until the fleet has moved.
//
// Gates: a recognized harness only (unknown surfaces → silent no-op); idempotent — a machine
// with a bearer for this origin is armed, so no directive (once per machine per
// connector, and the bearer lives as long as its grant).
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { resolveOrigin, stageTicket, hasBearer, detectHarness } from './lib/hookauth.mjs';
import { healQuietly } from './lib/self-heal.mjs'; // a frozen session runs current code: forward the older builds beside this one
healQuietly(import.meta.url);

/** The plugin's baked origin — generated at build (lib/origin.mjs); source-tree runs (the rig)
 *  fall back to prod, which the rig's env pins override anyway. */
async function bakedOrigin() {
  try { return (await import('./lib/origin.mjs')).BAKED_ORIGIN; } catch { return 'https://pathsayer.com'; }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  const payload = await readStdin().catch(() => ({}));
  const event = payload.hook_event_name || 'SessionStart';

  // MINT'S POLICY: arm on ANY recognized harness — the client token authenticates the recon
  // hooks wherever they run (local claude-code, codex, a container). Unknown → silent no-op
  // (never guess). Detection is shared (detectHarness — payload-first, because
  // codex inherits the parent env).
  if (!detectHarness(process.env, payload).harness) return;

  // the shared auth module owns paths, freshness, and locking. The rig's and the
  // containers' PATHSAYER_TOKEN_FILE / PATHSAYER_TICKET_FILE pins are honored inside it.
  const origin = resolveOrigin({ baked: await bakedOrigin() });
  const sessionId = payload.session_id || 'default';
  // ONCE PER MACHINE, BY ANY RUNG (2026-09-15): the tray's client-token file, PATHSAYER_TOKEN,
  // or the cached bearer — any of them is silence, whatever session this is. Only a machine with
  // none (no tray signed in, no variable, no cached bearer) hears anything.
  if (hasBearer({ origin })) return;

  // ONE plain line to the USER (`systemMessage` is the hook field the harness shows the person,
  // never the model) — install and sign in to the tray, or create a token and set the variable.
  // Nothing goes to the model: since the plugin's MCP entry became the local proxy (2026-09-15)
  // the `mint_client_token` op has no principal to mint for through it, so the directive that used
  // to follow this line (call the op with a staged ticket; the hooks redeem it) is retired here —
  // no ticket is staged, no model call is asked for. The op and the redeem route stay on the
  // server for plugins that have not updated, until the fleet has moved.
  void event; void sessionId; void randomBytes; void stageTicket;
  const userLine =
    'Pathsayer: this machine\'s recon hooks are not armed. Install and sign in to the Pathsayer tray, ' +
    'or set PATHSAYER_TOKEN from "Connect Cloud Device" on pathsayer.com/app.';
  process.stdout.write(JSON.stringify({ systemMessage: userLine }));
}

// Ends by returning, never process.exit — Node 24 on Windows aborts at exit after a fetch
// (2026-09-10, Cameron; the why is on recon-hook.mjs's tail, the pin is windows-exit.test.mjs).
main()
  .then(() => { process.exitCode = 0; })
  .catch(() => { process.exitCode = 0; }); // fail-open: a mint-hook error must never block the turn
