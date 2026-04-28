#!/bin/bash
# test-slices.sh — run all slice fixtures against their slices and report pass/fail.
#
# Usage:
#   ./bin/test-slices.sh [slice-id]
#
# Exits non-zero if any fixture fails — suitable for CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

FIXTURES_ROOT="$AUTOMATIONS_ROOT/slice-fixtures"
DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:3737}"

if [[ ! -d "$FIXTURES_ROOT" ]]; then
  echo "no slice-fixtures directory — nothing to run"
  exit 0
fi

target_slice="${1:-}"
failed=0
ran=0

for sdir in "$FIXTURES_ROOT"/*/; do
  sid="$(basename "$sdir")"
  if [[ -n "$target_slice" && "$sid" != "$target_slice" ]]; then
    continue
  fi
  for f in "$sdir"*.json; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f" .json)"
    ran=$((ran + 1))
    printf "→ %s/%s ... " "$sid" "$name"
    resp="$(curl -sS -X POST "$DASHBOARD_URL/api/slices/$sid/fixtures/$name" || true)"
    all_passed="$(echo "$resp" | jq -r '.all_passed // "error"')"
    if [[ "$all_passed" == "true" ]]; then
      echo "pass"
    else
      failed=$((failed + 1))
      echo "FAIL"
      echo "$resp" | jq -r '.outcomes[]? | "    - " + (.assertion.kind // "?") + ": " + (if .passed then "ok" else (.message // "fail") end)'
    fi
  done
done

echo
echo "ran: $ran  failed: $failed"
[[ "$failed" -eq 0 ]] || exit 1
