#!/bin/sh
# The Pathsayer statusline renderer. STRICTLY READ-ONLY (the law:
# ccusage cold-runs cost ~4 CPU-s against a 2GB corpus — anything that computes
# belongs in a hook or a detached background job, never in the tick).
#   line 1: the user's wrapped statusline, if any (PATHSAYER_STATUSLINE_WRAP, or
#           ccusage when present) — served from a per-session cache refreshed by a
#           detached job at most every 300s.
#   line 2: this session's Pathsayer status file (hook-written),
#           fitted to the terminal ($COLUMNS — Claude Code sets it for this script
#           since 2.1.153; else 110 cells), decayed to bare '🏔  Pathsayer' when
#           stale (>10 min by file mtime).
# Refresh is event-driven (no refreshInterval) — ratified 08-05.

input=$(cat)
sid=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"/\1/')
sid=$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)
[ -n "$sid" ] || sid=global

mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }  # -c FIRST: on Linux `-f` is valid (filesystem status) and succeeds with a dump, so it must not be tried first

# ── line 1: wrapped statusline (optional, cached, never inline) ──
WRAP="${PATHSAYER_STATUSLINE_WRAP-}"
if [ -z "$WRAP" ] && command -v ccusage >/dev/null 2>&1; then WRAP="ccusage statusline"; fi
if [ -n "$WRAP" ]; then
  CACHE="/tmp/pathsayer-wrapline-$sid"
  LOCK="$CACHE.lock"
  now=$(date +%s)
  lockm=$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo "$now")
  [ $((now - lockm)) -ge 120 ] && rmdir "$LOCK" 2>/dev/null
  if [ $((now - $(mt "$CACHE"))) -ge "${PATHSAYER_WRAP_TTL:-300}" ] && mkdir "$LOCK" 2>/dev/null; then
    (
      printf '%s' "$input" | sh -c "$WRAP" >"$CACHE.tmp" 2>/dev/null && mv "$CACHE.tmp" "$CACHE"
      rmdir "$LOCK" 2>/dev/null
    ) >/dev/null 2>&1 &
  fi
  cat "$CACHE" 2>/dev/null
fi

# ── transcript-marker derivation ── pull the newest mcp_tool-surface
# serve (edit/read/bash/task) out of the session transcript into the state file,
# newest-wins. Foreground: one node boot only when the transcript grew (cursor
# cache), well under the 300ms debounce. Fail-open: errors leave state untouched.
# The same boot RENDERS line 2 (fresh state fitted to $COLUMNS, else the bare word)
# so width-aware truncation costs no second process; empty output → sh fallback.
line2=''
if command -v node >/dev/null 2>&1; then
  line2=$(printf '%s' "$input" | node "$(dirname "$0")/lib/transcript-status.mjs" 2>/dev/null)
fi

# ── line 2: the Pathsayer line ──
if [ -n "$line2" ]; then
  printf '%s\n' "$line2"
else
  STATE="/tmp/pathsayer-status-$sid"
  if [ -r "$STATE" ] && [ $(( $(date +%s) - $(mt "$STATE") )) -le "${PATHSAYER_STATUS_FRESH:-600}" ]; then
    head -1 "$STATE"
  else
    printf '🏔  Pathsayer\n'
  fi
fi
