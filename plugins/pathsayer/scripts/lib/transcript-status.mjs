#!/usr/bin/env node
// transcript-marker derivation. The mcp_tool serves (edit/read/bash/
// task recon) never touch a local process — but Claude Code writes every served
// additionalContext into the session transcript JSONL as an `attachment` record.
// This helper, invoked by statusline.sh per repaint, tail-scans the transcript from
// a cached byte cursor, extracts the NEWEST serve's first attribution body (same
// grammar as the hook writers), and — newest-wins by ts against the state file's
// sidecar — writes the state file. Zero hook changes, zero tool-path latency; the
// bar renders the same bytes the model received.
// FAIL-OPEN everywhere: any error exits 0 silently; a broken derivation must never
// break the statusline (the renderer prints whatever state exists).
import { openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { serveSummary, reconBody, composeLine, writeStatus, statusPath, fitLine, terminalColumns, markerFiles, barFiles, barNames } from './status.mjs';

const MARK_RECON = 'pathsayer-recon/';
/** First run (no cursor): scan at most this much of the transcript tail. */
const FIRST_SCAN_BYTES = 512 * 1024;

const cursorPath = (sid) => `${statusPath(sid)}.cursor`;

/** Depth-first search for marker-bearing text inside a parsed record. */
function findServeText(o) {
  if (typeof o === 'string') return o.includes(MARK_RECON) ? o : null;
  if (Array.isArray(o)) { for (const v of o) { const r = findServeText(v); if (r) return r; } return null; }
  if (o && typeof o === 'object') { for (const v of Object.values(o)) { const r = findServeText(v); if (r) return r; } return null; }
  return null;
}

/** Walk marker → the deep-recon line (2026-08-29; labelled 'Recon (deep)' since 2026-09-09 — Gary:
 *  the bar paints EVERY walk, whichever door seeded it, so a question-shaped deep recon under
 *  the skill's Deep effort shows the same way a commit's does; until then only a diff-shaped walk
 *  painted and a prompt-triggered walk left the quick line standing). The walk= token carries the
 *  graph's deterministic shape — counts of candidates to read, NEVER verdicts (the same
 *  rule the old chk marker obeyed). Reads like:
 *  `Recon (deep) · walked 27 writes, 5 replaced · found 2 overlaps, 2 absences · 31% new ground`
 *  New ground and unmatchable are diff-door facts and appear only when nonzero; a capped walk
 *  appends `large history, N% visited`; a priorless commit reads `Recon (deep) · 100% new ground`;
 *  a walk that resolved nothing reads `Recon (deep) · walked 0 writes`. (120 S1f: `ab` counts the
 *  absence check; historical `dc` markers still render their decisions segment — the
 *  transcript's past is not rewritten.) */
const WALK_LABEL = 'Recon (deep)';
export function walkCounts(text) {
  const m = /pathsayer-recon\/\d+ rcn=rcn_[0-9a-f]{16}[^>]*? walk=([a-z0-9:,]+)/.exec(text);
  if (!m) return null;
  const kv = Object.fromEntries(m[1].split(',').map((p) => p.split(':')));
  const num = (k) => Number(kv[k] ?? 0);
  const [n, rp, ov, dc, ab, ng, x] = [num('n'), num('rp'), num('ov'), num('dc'), num('ab'), num('ng'), num('x')];
  if (n === 0) {
    const parts = [];
    if (ng > 0) parts.push(`${ng}% new ground`);
    if (x > 0) parts.push(`${x} unmatchable`);
    return `${WALK_LABEL} · ${parts.length > 0 ? parts.join(' · ') : 'walked 0 writes'}`;
  }
  const segs = [`walked ${n} write${n === 1 ? '' : 's'}${rp > 0 ? `, ${rp} replaced` : ''}`];
  const found = [];
  if (ov > 0) found.push(`${ov} overlap${ov === 1 ? '' : 's'}`);
  if (dc > 0) found.push(`${dc} decision${dc === 1 ? '' : 's'}`); // historical markers only — dc never mints again (120 S1f)
  if (ab > 0) found.push(`${ab} absence${ab === 1 ? '' : 's'}`);
  if (found.length > 0) segs.push(`found ${found.join(', ')}`);
  if (ng > 0) segs.push(`${ng}% new ground`);
  if (x > 0) segs.push(`${x} unmatchable`);
  if (kv.t === '1') segs.push(`large history, ${num('mk')}% visited`);
  return `${WALK_LABEL} · ${segs.join(' · ')}`;
}


export function deriveFromTranscript(transcriptPath, sessionId) {
  const size = statSync(transcriptPath).size;
  let start = 0;
  try { start = JSON.parse(readFileSync(cursorPath(sessionId), 'utf8')).offset ?? 0; } catch { /* first run */ }
  if (start > size) start = 0; // truncated/rotated — rescan
  let clamped = false; // a cursor sits on a line boundary; a first-run clamp lands mid-line
  if (start === 0 && size > FIRST_SCAN_BYTES) { start = size - FIRST_SCAN_BYTES; clamped = true; }
  if (size <= start) return; // nothing new — the ~ms common case

  const fd = openSync(transcriptPath, 'r');
  let chunk;
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    chunk = buf.toString('utf8');
  } finally { closeSync(fd); }

  // Only complete lines: a record may be mid-write at EOF. The cursor advances to
  // the end of the last complete line so a partial record is re-read next time.
  // A clamped start also drops its leading partial line.
  if (clamped) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) return;
    start += nl + 1;
    chunk = chunk.slice(nl + 1);
  }
  const end = chunk.lastIndexOf('\n');
  if (end < 0) return;
  const complete = chunk.slice(0, end);

  let newest = null; // { ts, body, surface, op }
  for (const ln of complete.split('\n')) {
    if (!ln.includes(MARK_RECON)) continue;
    let rec; try { rec = JSON.parse(ln); } catch { continue; }
    // assistant records can QUOTE marker text when discussing the system — never
    // derive status from the model's own prose, only from injected/tool content.
    if (rec.type === 'assistant') continue;
    const text = findServeText(rec);
    if (!text) continue;
    const ts = rec.timestamp ?? null;
    let body = null; let op = null; let surface = null; let kind = null;
    const wlk = walkCounts(text);
    if (wlk) {
      body = wlk; op = 'walk';
    } else {
      // 2026-08-26 (Gary): the marker's structured groups are the bar's ONE source — files (/4)
      // and authors (/6). The rendered text only decides whether a pre-/4 record was a serve at
      // all (statements-only serves never painted — ratified); its header names are never read.
      const served = markerFiles(text) ?? undefined;
      if (!served && !serveSummary(text).body) continue;
      // 2026-08-24 (Gary): the bar never paints attribution text — and since /4 the marker
      // carries the bar's file groups, so this lane paints the SAME 3/1/1 bar the hook paints
      // from the response sidecar, for every recon type. Pre-/4 serves (prod until the next
      // deploy, historical transcripts): the serve header's anchor file when the fire had one
      // (`recon (bash-post <file> · …)`); a prompt-shaped header has none → the bare word.
      const head = /^recon \(([A-Za-z_:-]+)(?: ([^\s·)]+))?/m.exec(text);
      surface = head?.[1] ?? null;
      let files = barFiles(served);
      if (files.length === 0) {
        const headerFile = head?.[2] !== undefined && /[./]/.test(head[2]) ? head[2].split('/').pop() : null;
        files = headerFile === null ? [] : [headerFile];
      }
      body = reconBody({ names: barNames(served), files });
      kind = files.length > 0 ? 'files' : 'served'; // mirrors the hook writer — 'attribution' retired
      op = 'recon';
    }
    if (!newest || String(ts) >= String(newest.ts)) newest = { ts, body, surface, op, kind };
  }

  try { writeFileSync(cursorPath(sessionId), JSON.stringify({ offset: start + end + 1 })); } catch { /* best effort */ }
  if (!newest) return;

  // newest-wins vs the state file's sidecar ts (hook writers stamp ISO ts too)
  try {
    const side = JSON.parse(readFileSync(statusPath(sessionId), 'utf8').split('\n')[1] ?? '{}');
    if (side.ts && newest.ts && String(side.ts) >= String(newest.ts)) return;
  } catch { /* no/invalid state — transcript wins */ }
  writeStatus(sessionId, composeLine(newest.body), {
    ts: newest.ts ?? undefined, op: newest.op, kind: newest.op === 'walk' ? 'walk' : newest.kind,
    source: 'transcript', surface: newest.surface ?? undefined,
  });
}

async function main() {
  const ch = [];
  for await (const c of process.stdin) ch.push(c);
  const payload = JSON.parse(Buffer.concat(ch).toString() || '{}');
  const t = payload.transcript_path;
  const sid = payload.session_id;
  if (t && sid) { try { deriveFromTranscript(t, sid); } catch { /* fail-open */ } }
  // Render line 2 in the same node boot (one per tick): fresh state → its display
  // line fitted to the terminal; stale/missing → the bare word. Freshness by file
  // mtime, same rule as the sh fallback (PATHSAYER_STATUS_FRESH, default 600s).
  process.stdout.write(`${renderLine(sid)}\n`);
}

export function renderLine(sessionId, env = process.env) {
  const bare = '🏔  Pathsayer';
  try {
    const p = statusPath(sessionId);
    const fresh = Number(env.PATHSAYER_STATUS_FRESH ?? 600) * 1000;
    if (Date.now() - statSync(p).mtimeMs > fresh) return bare;
    const line = readFileSync(p, 'utf8').split('\n')[0];
    return line ? fitLine(line, terminalColumns(env)) : bare;
  } catch { return bare; }
}

// Direct-execution guard (the 2026-07 nudge lesson): importing must not read stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}
