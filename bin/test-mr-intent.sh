#!/bin/bash
# test-mr-intent.sh - regression tests for GitLab MR link intent handling.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/mr-intent.sh
source "$SCRIPT_DIR/lib/mr-intent.sh"

pass_count=0

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_guard() {
  local label="$1"
  local message="$2"
  local expected="$3"
  local actual=0
  if saturn_should_apply_gitlab_mr_intent_guard "$message"; then
    actual=1
  fi
  [[ "$actual" == "$expected" ]] || fail "$label expected guard=$expected, got $actual"
  pass_count=$((pass_count + 1))
}

assert_contains() {
  local label="$1"
  local haystack="$2"
  local needle="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label missing: $needle"
  pass_count=$((pass_count + 1))
}

assert_guard \
  "MR diff URL gets the intent guard" \
  "https://gitlab.com/sondermind/backend/agent-service/-/merge_requests/566/diffs#abc make sure file names match tool names" \
  1

assert_guard \
  "self-hosted GitLab MR URL gets the intent guard" \
  "check https://gitlab.example.com/group/project/-/merge_requests/42" \
  1

assert_guard \
  "legacy GitLab MR path gets the intent guard" \
  "check http://gitlab.example.com/group/project/merge_requests/42" \
  1

assert_guard \
  "MR URLs followed by sentence punctuation get the intent guard" \
  "check https://gitlab.example.com/group/project/-/merge_requests/42." \
  1

assert_guard \
  "native slash commands keep their native semantics" \
  "/review https://gitlab.com/group/project/-/merge_requests/42" \
  0

assert_guard \
  "non-MR GitLab URLs do not get the guard" \
  "look at https://gitlab.com/group/project/-/issues/42" \
  0

assert_guard \
  "malformed MR URLs do not get the guard" \
  "look at https://gitlab.com/group/project/-/merge_requests/not-a-number" \
  0

assert_guard \
  "MR URLs with suffix letters after the IID do not get the guard" \
  "look at https://gitlab.com/group/project/-/merge_requests/42abc" \
  0

prompt="we need to make sure all of the file names match the tool names"
guarded="$(saturn_prepend_gitlab_mr_intent_guard "$prompt")"

assert_contains \
  "guard says MR URLs are not implicit reviews" \
  "$guarded" \
  "not automatically a request for broad code assessment"

assert_contains \
  "guard preserves targeted requests" \
  "$guarded" \
  "For targeted asks, do only that targeted check or change."

assert_contains \
  "guard still allows explicit reviews" \
  "$guarded" \
  "unless the user explicitly asks for a review"

assert_contains \
  "guard preserves the original prompt" \
  "$guarded" \
  "$prompt"

grep_output="$(mktemp "${TMPDIR:-/tmp}/saturn-mr-intent.XXXXXX")"
if grep -n "review context" "$SCRIPT_DIR/../dashboard/lib/gitlab-mr.ts" >"$grep_output"; then
  cat "$grep_output" >&2
  rm -f "$grep_output"
  fail "dashboard MR attachment text must not call itself review context"
fi
rm -f "$grep_output"
pass_count=$((pass_count + 1))

echo "mr intent tests passed: $pass_count"
