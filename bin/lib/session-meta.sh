#!/bin/bash
# session-meta.sh — meta.json read/write helpers for Saturn session scripts.
#
# Sourced by run-turn.sh. Provides a lock-coordinated writer that wraps the
# jq + temp-file + atomic-rename pattern every meta update needs. Depends on
# bin/lib/meta-lock.sh being sourced first (or in the same process).
#
# Required caller-scope variables when calling saturn_meta_update:
#   $META_FILE    — absolute path to the session's meta.json
#   $SESSION_DIR  — absolute path to the session dir (for the meta.lock)

if [[ -n "${SATURN_SESSION_META_SH_LOADED:-}" ]]; then
  return 0
fi
SATURN_SESSION_META_SH_LOADED=1

# saturn_meta_update <jq-program> [<jq-args>...]
# Atomic, lock-coordinated rewrite of $META_FILE: acquires the meta lock,
# applies the jq program (with the same arg-passing convention as `jq`),
# swaps tmp→meta.json with mv (POSIX-atomic), then releases the lock.
#
# Best-effort with respect to the lock — if the lock can't be acquired
# within meta-lock.sh's timeout the rewrite still happens (the caller is
# the one chiefly serialized by it; the dashboard background route can
# retry on its own snapshot).
saturn_meta_update() {
  local lock_file
  lock_file="$(saturn_meta_lock_acquire "$SESSION_DIR" || true)"
  jq "$@" "$META_FILE" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "$META_FILE"
  local rc=$?
  saturn_meta_lock_release "$lock_file"
  return "$rc"
}
