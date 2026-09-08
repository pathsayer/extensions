// The statusline state contract. ONE writer module shared by every
// local hook; the renderer (statusline.sh) is strictly read-only against the file
// this writes. The line IS content: the first served attribution's text
// (ratified 08-05 — attributions only, no statements, no metric counts). Writers
// carry the FULL body; width is a render-time fact (ratified 08-21): Claude Code
// sets $COLUMNS for the statusline script (≥2.1.153), so the renderer fits the
// line to the terminal in cells — the old ≤80 writer budget was a chosen number,
// never a measured limit.
//
// File: /tmp/pathsayer-status-<session_id>
//   line 1: the display string (ANSI allowed; renderer passes it through)
//   line 2: JSON sidecar {ts, op, surface, ...} — richer rendering later without
//           touching writers. Staleness decay keys off file mtime, not the sidecar.
// Writes are atomic (tmp + rename) — the renderer may run concurrently on any tick.
// Every export is fail-open: a status write must NEVER break serving.
import { writeFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = '🏔  Pathsayer'; // double space: emoji-width, measured
const SEP = ' · ';
/** Terminal width when Claude Code doesn't tell us ($COLUMNS unset on <2.1.153). */
const DEFAULT_COLUMNS = 110;
const DIM = '\x1b[2m';
const UNDIM = '\x1b[22m';

/** /tmp path for a session's status file; sid sanitized, empty → 'global'. */
export function statusPath(sessionId) {
  const sid = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'global';
  return `/tmp/pathsayer-status-${sid}`;
}

/** Word-boundary truncation with ellipsis (display-grapheme approximation). */
export function truncateLine(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if ([...t].length <= max) return t;
  const arr = [...t].slice(0, Math.max(1, max - 2));
  let cut = arr.join('');
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return `${cut} …`;
}

/** `🏔  Pathsayer · <body>` — whitespace-collapsed, NOT truncated (the renderer fits). */
export function composeLine(body) {
  return `${PREFIX}${SEP}${String(body).replace(/\s+/g, ' ').trim()}`;
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** Terminal cells a string occupies: ANSI SGR = 0, pictographic/wide = 2, else 1
 *  (grapheme-level; a display approximation, same family as truncateLine). */
export function displayWidth(s) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const { segment: g } of seg.segment(String(s).replace(ANSI, ''))) {
    n += /\p{Extended_Pictographic}|[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(g) ? 2 : 1;
  }
  return n;
}

/** Fit a display line to `cols` cells: untouched when it fits (ANSI intact, byte-
 *  identical); otherwise cut at a word boundary with ' …'. `cols` ≤ 0 → untouched. */
export function fitLine(line, cols) {
  const s = String(line);
  if (!(cols > 0) || displayWidth(s) <= cols) return s;
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = [...seg.segment(s.replace(ANSI, ''))].map((x) => x.segment);
  const budget = cols - 2; // room for ' …'
  let out = ''; let w = 0;
  for (const g of graphemes) {
    const gw = displayWidth(g);
    if (w + gw > budget) break;
    out += g; w += gw;
  }
  const sp = out.lastIndexOf(' ');
  if (sp > budget * 0.6) out = out.slice(0, sp);
  return `${out.trimEnd()} …`;
}

/** Columns Claude Code reported for the statusline script; DEFAULT_COLUMNS when absent. */
export function terminalColumns(env = process.env) {
  const n = Number.parseInt(env.COLUMNS ?? '', 10);
  return n > 0 ? n : DEFAULT_COLUMNS;
}

const ENTRY = /^- \[(what|why|intent)\] (.*)$/;

/** What the rendered text still tells the transcript lane (Gary 2026-08-21):
 *  - `body`: the FIRST attribution's text — explicitly intent → why → what, never "whichever
 *    body rendered first". Statements never count (their text rides the tag line).
 *  (The NAME harvest off the entry header is RETIRED, 2026-08-26: the /5 header put an atr_id
 *  between the name and the turn — `day · Gary · atr_… · turn …` — and the `day · name · turn`
 *  regex went silently blind; every bar from 08-24 read files-only. Names ride the sidecar /
 *  the /6 marker as data now (barNames), the same law the files got on 08-23. This function
 *  never reads a header again, in any shape.) */
export function serveSummary(rendered) {
  const lines = String(rendered ?? '').split('\n');
  const files = [];
  let body = null;
  let first = true;
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY.exec(lines[i]);
    if (!m) continue;
    // (the [since] FILE HARVEST is retired, 2026-08-23: since 08-22 the served `[since]` row is the
    // one-line mini — `60% alive (316/520 lines) · …`, `not in git` — not per-file rows, so the
    // first-token harvest was collecting "60%", "not", "100%" and the bar read
    // "Gary: not, 100%, 62%". Files' one home now is the full `since` at the get; the bar's tail falls
    // back to the first attribution's text, which reconBody already does when files is empty.)
    if (!first) continue;
    first = false;
    // the entry's bodies by kind: the tag names the first body; `[why]`/`[code]`/`[since]`
    // prefixes name the rest (hook-serve.ts attrEntryLines).
    const kinds = { intent: null, why: null, what: null };
    let nextKind = m[1];
    for (let j = i + 1; j < lines.length && /^\s{2,}/.test(lines[j]); j++) {
      const t = lines[j].trim();
      const pre = /^\[(why|code|since)\] /.exec(t);
      const kind = pre ? pre[1] : nextKind;
      nextKind = null; // only the first body line is the tag's own
      if (kind === 'since' || kind === 'code' || kind === null) { if (kind === null) nextKind = null; continue; }
      if (kinds[kind] == null && t) kinds[kind] = t.replace(pre ? pre[0] : '', '').replace(/\*\*/g, '');
    }
    body = kinds.intent ?? kinds.why ?? kinds.what ?? null;
  }
  return { body, files };
}

/** First served attribution's text (intent → why → what) — see serveSummary. */
export function firstAttributionBody(rendered) {
  return serveSummary(rendered).body;
}

/** Atomic write of line + sidecar. Fail-open: swallows everything. */
export function writeStatus(sessionId, line, meta = {}) {
  try {
    const dest = statusPath(sessionId);
    const sidecar = JSON.stringify({ ts: new Date().toISOString(), ...meta });
    const dir = mkdtempSync(join(tmpdir(), 'ps-status-'));
    const tmp = join(dir, 'status');
    writeFileSync(tmp, `${line}\n${sidecar}\n`);
    renameSync(tmp, dest);
    rmSync(dir, { recursive: true, force: true });
  } catch { /* never surface */ }
}

/** A serve landed: `Recon · …`; bare `Recon` when the serve carried no sidecar
 *  (Gary 08-05: no 'served' word). The rendered text paints NOTHING. */
export function writeServe(sessionId, renderedText, meta = {}, sidecar = null) {
  // 2026-08-23 (Gary, ruled) — the bar's files come from the serve's STRUCTURED sidecar
  // (`pathsayer.served`), never from parsing the rendered text (the harvest that read
  // "Gary: not, 100%, 62%" off the mini rows). 2026-08-26 — the names too (`served[].author`):
  // the header harvest went blind on the /5 header's atr_id and nobody's test noticed.
  void renderedText;
  const files = barFiles(sidecar?.served);
  writeStatus(sessionId, composeLine(reconBody({ names: barNames(sidecar?.served), files })), { op: 'recon', kind: files.length > 0 ? 'files' : 'served', ...meta });
}

/** First names of the served authors (`served[].author`, the full account name), deduped,
 *  serve order; an entry without an author contributes none (Gary 2026-08-26). */
export function barNames(served) {
  if (!Array.isArray(served)) return [];
  const out = [];
  for (const s of served) {
    const first = String(s?.author ?? '').trim().split(/\s+/)[0];
    if (first && !out.includes(first)) out.push(first);
  }
  return out;
}

/** ≤5 basenames: 3 from the first served attribution, 1 each from the second and third; dedup by
 *  CANONICAL path (a repeated basename from two dirs is two files); a dup takes that attribution's
 *  next-in-line within its returned top 3, exhaustion contributes nothing (Gary 2026-08-23). */
export function barFiles(served) {
  if (!Array.isArray(served) || served.length === 0) return [];
  const seen = new Set();
  const out = [];
  const take = (entry, want) => {
    let n = 0;
    for (const f of entry?.files ?? []) {
      if (n >= want || out.length >= 5) return;
      if (!f?.file || seen.has(f.file)) continue;
      seen.add(f.file);
      out.push(f.file.split('/').pop());
      n++;
    }
  };
  take(served[0], 3);
  take(served[1], 1);
  take(served[2], 1);
  return out;
}

/** /4 marker parse (2026-08-24, Gary): the bar's file groups ride the marker itself —
 *  `files=` after `rcn=`, positional per-attribution groups `;`-joined, URI-encoded canonical
 *  paths `,`-joined — so ANY lane's transcript record paints the same 3/1/1 bar the response
 *  sidecar paints (barFiles is the one selection algorithm). /6 (2026-08-26): `authors=` after
 *  `files=`, positional URI-encoded full names, '' = unknown — parsed into the same entries as
 *  `author`, so barNames paints identically from a transcript record or a response. Either
 *  field alone parses. Returns the sidecar's `served` shape; pre-/4 markers, absent markers,
 *  torn encodings → null, never a throw. */
export function markerFiles(text) {
  const m = /pathsayer-recon\/\d+ rcn=rcn_[0-9a-f]{16}((?: files=\S+)?(?: authors=\S+)?)/.exec(String(text ?? ''));
  if (!m || !m[1]) return null;
  const files = /files=(\S+)/.exec(m[1])?.[1];
  const authors = /authors=(\S+)/.exec(m[1])?.[1];
  try {
    const groups = files ? files.split(';') : [];
    const names = authors ? authors.split(';') : [];
    const out = [];
    for (let i = 0; i < Math.max(groups.length, names.length); i++) {
      const author = names[i] ? decodeURIComponent(names[i]) : '';
      out.push({
        ...(author ? { author } : {}),
        files: (groups[i] ?? '').split(',').filter(Boolean).map((p) => ({ file: decodeURIComponent(p) })),
      });
    }
    return out;
  } catch { return null; }
}

/** `Recon · Gary, Gary2: d.txt, status.mjs` — who decided, over which files. 2026-08-24 (Gary):
 *  attribution TEXT never paints — no files → names only; no names → bare `Recon`
 *  (Gary 08-05: no 'served' word). Both default empty: a caller with no sidecar never throws. */
export function reconBody({ names = [], files = [] }) {
  if (files.length === 0) return names.length > 0 ? `Recon · ${names.join(', ')}` : 'Recon';
  return names.length > 0 ? `Recon · ${names.join(', ')}: ${files.join(', ')}` : `Recon · ${files.join(', ')}`;
}

/** Plain-language rendering of a ServeStatus. Unknown/absent → the bare word, so
 *  a new status added server-side degrades to today's line instead of leaking an
 *  identifier at the user. 'served' never reaches here (writeServe owns it). */
const SILENT_WORDS = {
  gave_up: 'gave up waiting',
  refused: 'service error',
  unreachable: 'service down',
  contract_mismatch: 'version mismatch',
  model_mismatch: 'model mismatch',
  empty_corpus: 'nothing to rank',
  render_empty: 'nothing rendered',
  internal_error: 'error',
};

/** The op ran and served nothing — shown dimmed (ratified: experience it). When the server
 *  said WHY (Gary 2026-08-07), the reason replaces the bare word: a cold fire reads as
 *  "gave up waiting", not as an unexplained blank the reader has to diagnose. */
export function writeSilent(sessionId, meta = {}) {
  const word = SILENT_WORDS[meta.status] ?? 'silent';
  writeStatus(sessionId, `${PREFIX}${SEP}${DIM}${word}${UNDIM}`, { op: 'recon', kind: 'silent', ...meta });
}

