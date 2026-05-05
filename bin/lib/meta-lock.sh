#!/bin/bash
# Cross-process advisory lock around `sessions/<id>/meta.json`.
#
# Mirrors dashboard/lib/session-meta-lock.ts so the dashboard (Node) and
# this script can coordinate writes to the same meta.json. Uses an O_EXCL
# sentinel file (`meta.lock`); falls back to proceeding without the lock
# after `META_LOCK_TIMEOUT_S` to avoid hanging the caller indefinitely.

if [[ -n "${SATURN_META_LOCK_SH_LOADED:-}" ]]; then
  return 0
fi
SATURN_META_LOCK_SH_LOADED=1

META_LOCK_TIMEOUT_S="${META_LOCK_TIMEOUT_S:-2}"
META_LOCK_STALE_S="${META_LOCK_STALE_S:-30}"

# saturn_meta_lock_path <session-dir>
saturn_meta_lock_path() {
  printf '%s/meta.lock\n' "$1"
}

# saturn_meta_lock_acquire <session-dir>
# Echoes the lock path on success; returns non-zero if the timeout elapsed
# (callers that want best-effort behavior should ignore the return code and
# still proceed — the lock is advisory).
saturn_meta_lock_acquire() {
  local session_dir="$1"
  local lock_file
  lock_file="$(saturn_meta_lock_path "$session_dir")"
  local deadline=$(( $(date +%s) + META_LOCK_TIMEOUT_S ))
  local stale_attempted=0

  while :; do
    # Atomic create-if-missing via noclobber + redirection.
    if (set -o noclobber; printf '{"pid":%d,"holder":"shell","acquired_at":"%s"}' \
          "$$" "$(date -u +%FT%TZ)" >"$lock_file") 2>/dev/null; then
      printf '%s\n' "$lock_file"
      return 0
    fi

    if [[ "$stale_attempted" -eq 0 && -f "$lock_file" ]]; then
      local age
      age="$(saturn_meta_lock_age_s "$lock_file")"
      if [[ -n "$age" && "$age" -ge "$META_LOCK_STALE_S" ]]; then
        rm -f "$lock_file" 2>/dev/null || true
        stale_attempted=1
        continue
      fi
    fi

    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      return 1
    fi

    # Short sleep with a bit of jitter to avoid lockstep contention.
    sleep "0.0$(( (RANDOM % 9) + 1 ))" 2>/dev/null || sleep 1
  done
}

# saturn_meta_lock_age_s <lock-file>
# Echoes the lock's age in whole seconds; empty on stat failure.
saturn_meta_lock_age_s() {
  local file="$1"
  local mtime now
  if mtime="$(stat -f %m "$file" 2>/dev/null)" \
      || mtime="$(stat -c %Y "$file" 2>/dev/null)"; then
    now="$(date +%s)"
    printf '%s\n' "$(( now - mtime ))"
  fi
}

# saturn_meta_lock_release <lock-file>
saturn_meta_lock_release() {
  local lock_file="$1"
  [[ -n "$lock_file" && -f "$lock_file" ]] || return 0
  if grep -Eq '"holder":"shell"|"holder"[[:space:]]*:[[:space:]]*"shell"' "$lock_file" 2>/dev/null \
      && grep -Eq "\"pid\":$$|\"pid\"[[:space:]]*:[[:space:]]*$$" "$lock_file" 2>/dev/null; then
    rm -f "$lock_file" 2>/dev/null || true
  fi
}
