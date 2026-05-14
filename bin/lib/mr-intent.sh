#!/bin/bash
# mr-intent.sh - GitLab MR URL intent helpers for Saturn chat turns.
#
# A merge request link in a normal chat message is a target/context pointer.
# It must not silently escalate the turn into a broad review workflow unless
# the user asks for that review explicitly.

if [[ -n "${SATURN_MR_INTENT_SH_LOADED:-}" ]]; then
  return 0
fi
SATURN_MR_INTENT_SH_LOADED=1

saturn_message_has_gitlab_mr_url() {
  local text="$1"
  local regex='https?://[^[:space:]<>")]+/(-/)?merge_requests/[0-9]+($|[^[:alnum:]_-])'
  [[ "$text" =~ $regex ]]
}

saturn_message_is_native_command() {
  local text="$1"
  [[ "$text" =~ ^[[:space:]]*/ ]]
}

saturn_should_apply_gitlab_mr_intent_guard() {
  local text="$1"
  saturn_message_has_gitlab_mr_url "$text" && ! saturn_message_is_native_command "$text"
}

saturn_gitlab_mr_intent_guard() {
  printf '%s' "MR link handling for the newest user request:
- A GitLab merge request URL is context or a target, not automatically a request for broad code assessment.
- Follow the user's explicit requested action. For targeted asks, do only that targeted check or change.
- Do not invoke broad assessment skills, slash commands, swarms, or specialist agents unless the user explicitly asks for a review, audit, approval, blockers, bugs, or findings."
}

saturn_prepend_gitlab_mr_intent_guard() {
  local prompt="$1"
  printf '%s\n\n%s' "$(saturn_gitlab_mr_intent_guard)" "$prompt"
}
