#!/bin/bash
# run-slice.sh — one-shot slice runner.
#
# Spawned by slice-executor.ts. Sources lib/cli-dispatch.sh for the same
# build_cli_args + run_with_watchdog helpers used by run-turn.sh / run-job.sh.
#
# Required env vars (caller sets these):
#   SESSION_ID      — parent orchestrator session id
#   SLICE_RUN_ID    — per-slice UUID (caller allocates)
#   SLICE_CLI       — "claude-bedrock" | "claude-personal" | "claude-local" | "codex" ("claude" aliases to claude-bedrock)
#   SLICE_TIMEOUT   — integer seconds (watchdog)
#
# Optional env vars:
#   SLICE_MODEL          — model id, or empty
#   SLICE_ALLOWED_TOOLS  — comma-separated, or empty
#   SLICE_CWD            — if set and dir exists, cd into it before running
#
# The output dir ($AUTOMATIONS_ROOT/sessions/$SESSION_ID/slices/$SLICE_RUN_ID/)
# MUST already exist (caller creates it). The prompt is read from stdin.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

# shellcheck source=lib/cli-dispatch.sh
source "$AUTOMATIONS_ROOT/bin/lib/cli-dispatch.sh"

usage() {
  echo "usage: SESSION_ID=<id> SLICE_RUN_ID=<uuid> SLICE_CLI=<claude-bedrock|claude-personal|claude-local|codex> SLICE_TIMEOUT=<sec> run-slice.sh  (prompt on stdin)" >&2
  echo "  optional: SLICE_MODEL, SLICE_ALLOWED_TOOLS (comma-sep), SLICE_CWD" >&2
}

# ─── Required env checks ──────────────────────────────────────────────────────
: "${SESSION_ID:=}"
: "${SLICE_RUN_ID:=}"
: "${SLICE_CLI:=}"
: "${SLICE_TIMEOUT:=}"

if [[ -z "$SESSION_ID" || -z "$SLICE_RUN_ID" || -z "$SLICE_CLI" || -z "$SLICE_TIMEOUT" ]]; then
  echo "run-slice: missing required env vars" >&2
  usage
  exit 2
fi

saturn_validate_path_segment "$SESSION_ID" "session id"
saturn_validate_path_segment "$SLICE_RUN_ID" "slice run id"
saturn_validate_timeout_seconds "$SLICE_TIMEOUT" "slice timeout"

SLICE_CLI="$(normalize_cli_id "$SLICE_CLI")"
SLICE_MODEL="${SLICE_MODEL:-}"
SLICE_ALLOWED_TOOLS="${SLICE_ALLOWED_TOOLS:-}"
SLICE_CWD="${SLICE_CWD:-}"

SLICE_DIR="$AUTOMATIONS_ROOT/sessions/$SESSION_ID/slices/$SLICE_RUN_ID"
if [[ ! -d "$SLICE_DIR" ]]; then
  echo "run-slice: slice dir not found: $SLICE_DIR" >&2
  exit 3
fi

STREAM_FILE="$SLICE_DIR/stream.jsonl"
STDERR_FILE="$SLICE_DIR/stderr.log"
PROMPT_FILE="$SLICE_DIR/prompt.txt"
OUTPUT_FILE="$SLICE_DIR/output.raw.txt"
META_FILE="$SLICE_DIR/meta.json"

# ─── Read prompt from stdin ───────────────────────────────────────────────────
PROMPT_TO_SEND="$(cat)"
if [[ -z "$PROMPT_TO_SEND" ]]; then
  echo "run-slice: empty prompt on stdin" >&2
  exit 4
fi

# Dump prompt to disk before running (so it survives failures/crashes)
printf '%s' "$PROMPT_TO_SEND" > "$PROMPT_FILE"

# Create empty files so tailers don't race the process
: > "$STREAM_FILE"
: > "$STDERR_FILE"

# ─── cd into sandbox dir if provided ──────────────────────────────────────────
if [[ -n "$SLICE_CWD" && -d "$SLICE_CWD" ]]; then
  cd "$SLICE_CWD"
fi

# ─── Build CLI args (empty session_id, is_resume=no — slices are always fresh)
build_cli_args "$SLICE_CLI" "$SLICE_MODEL" "$SLICE_ALLOWED_TOOLS" "" "no"

append_plugin_mcp_config_arg "$SLICE_CLI" "$SLICE_DIR/plugin-mcp-config.json" "$STDERR_FILE"

# ─── Run with watchdog ────────────────────────────────────────────────────────
# macOS BSD `date` doesn't support %N, so use python3 for millisecond precision.
epoch_ms() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH_MS="$(epoch_ms)"

# run_with_watchdog writes turn_pid / script_pid / cli_pgid to this file while
# the CLI runs, so slice-executor.ts can signal the whole CLI process group
# when the token budget is exceeded or the parent session is aborted.
export CLI_PIDS_FILE="$SLICE_DIR/pids.json"

run_with_watchdog "$SLICE_TIMEOUT" "$STREAM_FILE" "$STDERR_FILE" "$PROMPT_TO_SEND"

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINISHED_EPOCH_MS="$(epoch_ms)"
DURATION_MS=$(( FINISHED_EPOCH_MS - STARTED_EPOCH_MS ))

# ─── Append completion sentinel so tailers know we're done ────────────────────
printf '%s\n' "{\"type\":\"_slice_done\",\"exit\":${EXIT_CODE}}" >> "$STREAM_FILE"

# ─── Extract final assistant text → output.raw.txt (format depends on CLI) ────
FINAL_TEXT=""
case "$SLICE_CLI" in
  claude-bedrock|claude-personal|claude-local)
    FINAL_TEXT="$(jq -rs '
      [ .[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text ]
      | if length == 0 then "" else .[-1] end
    ' "$STREAM_FILE" 2>/dev/null || true)"
    ;;
  codex)
    # Codex exec emits {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    FINAL_TEXT="$(jq -rs '
      [.[] | select(.type == "item.completed") | .item | select(.type == "agent_message") | .text // ""]
      | if length > 0 then .[-1] else "" end
    ' "$STREAM_FILE" 2>/dev/null || true)"
    ;;
esac

# Fallback: grab last object with a .text field across any format
if [[ -z "$FINAL_TEXT" ]]; then
  FINAL_TEXT="$(jq -rs 'last // "" | if type == "object" then (.text // "") else "" end' "$STREAM_FILE" 2>/dev/null || true)"
fi

printf '%s' "$FINAL_TEXT" > "$OUTPUT_FILE"

# ─── Write meta.json ──────────────────────────────────────────────────────────
STATUS="success"
[[ "$EXIT_CODE" -ne 0 ]] && STATUS="failed"

jq -n \
  --arg slice_run_id "$SLICE_RUN_ID" \
  --arg session_id "$SESSION_ID" \
  --arg cli "$SLICE_CLI" \
  --arg model "$SLICE_MODEL" \
  --arg started_at "$STARTED_AT" \
  --arg finished_at "$FINISHED_AT" \
  --argjson duration_ms "$DURATION_MS" \
  --argjson exit_code "$EXIT_CODE" \
  --arg status "$STATUS" \
  --argjson timeout_seconds "$SLICE_TIMEOUT" \
  '{
    slice_run_id: $slice_run_id,
    session_id: $session_id,
    cli: $cli,
    model: (if $model == "" then null else $model end),
    started_at: $started_at,
    finished_at: $finished_at,
    duration_ms: $duration_ms,
    exit_code: $exit_code,
    status: $status,
    timeout_seconds: $timeout_seconds
  }' > "$META_FILE"

exit "$EXIT_CODE"
