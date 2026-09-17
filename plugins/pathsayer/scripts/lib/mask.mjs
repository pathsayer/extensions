// The mask (2026-09-17) — the plugin masks the exact bytes of the credential it holds, before
// anything leaves the machine. The one law: the mask is the SAME LENGTH as the secret, written as
// 0x2a ('*'). The only write here is a fill of the matched range, so a length change is not
// expressible — the declared frontier is the file's byte size, chunks are aligned slices, and every
// cursor and turn address behind them is a byte offset (measured 2026-09-16: byte_hwm, slice
// length and all 41 record offsets identical before and after).
//
// Why exact bytes are enough (measured 2026-09-16): a printed credential lands in a transcript
// contiguous and byte-identical — base64url has nothing JSON escapes, nothing wraps or splits it.
// Why no page-boundary case: the courier masks the WHOLE buffer it read, and the tray masks its
// newline-bounded tail, so a secret is never split across two calls.
//
// `secrets` is one string or a list (every rung the ladder can see — hookauth's heldSecrets);
// empties and non-strings are skipped, so a machine with no credential masks nothing and pays
// nothing (the input is returned as is when no secret occurs in it).

const MASK_BYTE = 0x2a;

const list = (secrets) => (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => typeof s === 'string' && s !== '');

/** Bytes (Buffer or Uint8Array) → the same bytes with every occurrence of every secret filled with
 *  '*'. The input is never mutated: a copy is made on the first match, the input itself is
 *  returned when there is none. */
export function maskExact(bytes, secrets) {
  const needles = list(secrets).map((s) => Buffer.from(s, 'utf8'));
  if (needles.length === 0 || !bytes || bytes.length === 0) return bytes;
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let out = null;
  for (const n of needles) {
    if (n.length === 0 || n.length > view.length) continue;
    let at = view.indexOf(n);
    while (at !== -1) {
      if (!out) out = Buffer.from(view); // first match: copy, never write into the caller's bytes
      out.fill(MASK_BYTE, at, at + n.length);
      at = view.indexOf(n, at + n.length);
    }
  }
  return out ?? bytes;
}

/** The string form for a serialized body (the adapter's fire, the proxy's message): every
 *  occurrence of every secret → the same number of '*'. */
export function maskExactString(text, secrets) {
  let out = text;
  for (const s of list(secrets)) if (out.includes(s)) out = out.split(s).join('*'.repeat(s.length));
  return out;
}
