#!/bin/bash
# run-turn.sh <session-id>
#
# Executes one chat turn for an existing session.
# Reads the user message from stdin.
#
# Required env vars (caller sets these — typically the /api/sessions/[id]/messages route):
#   CLI         — "claude-bedrock" | "claude-personal" | "claude-local" | "codex"  (can differ from previous turn)
#   MODEL       — model id, or empty
#   REASONING_EFFORT — optional thinking/reasoning level
#
# The session dir ($AUTOMATIONS_ROOT/sessions/<session-id>/) must already exist with a meta.json.
# This script:
#   1. Reads the current turn list + agent snapshot from meta.json
#   2. If previous turn used the same CLI and has a cli_session_id, resume it natively
#   3. Otherwise, build a transcript-replay prompt (happens on first turn OR CLI switch)
#   4. Appends the CLI's JSONL output to the session's stream.jsonl
#   5. Extracts the new cli_session_id and updates meta.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

SESSIONS_ROOT="$AUTOMATIONS_ROOT/sessions"

# If the script exits unexpectedly (set -e), ensure session is not left in "running" state
_cleanup_on_exit() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    local meta="${META_FILE:-}"
    if [[ -n "$meta" && -f "$meta" ]]; then
      jq '.status = "failed" | del(.last_turn_started_at)' "$meta" > "${meta}.tmp" 2>/dev/null \
        && mv "${meta}.tmp" "$meta" || true
    fi
  fi
  rm -f "${LOCK_FILE:-}" 2>/dev/null || true
}
trap _cleanup_on_exit EXIT

# shellcheck source=lib/cli-dispatch.sh
source "$AUTOMATIONS_ROOT/bin/lib/cli-dispatch.sh"

if [[ $# -ne 1 ]]; then
  echo "usage: run-turn.sh <session-id>  (user message on stdin)" >&2
  exit 2
fi
SESSION_ID="$1"
SESSION_DIR="$SESSIONS_ROOT/$SESSION_ID"

if [[ ! -d "$SESSION_DIR" ]]; then
  echo "run-turn: session dir not found: $SESSION_DIR" >&2
  exit 3
fi

CLI="$(normalize_cli_id "${CLI:-claude-bedrock}")"
MODEL="${MODEL:-}"
REASONING_EFFORT="${REASONING_EFFORT:-}"

# Claude-family backends share the same binary but use different providers.
# Keep CLI distinct for resume decisions, map only the execution engine.
ENGINE="$CLI"
[[ "$CLI" == claude-* ]] && ENGINE="claude"

USER_MESSAGE="$(cat)"
if [[ -z "$USER_MESSAGE" ]]; then
  echo "run-turn: empty user message" >&2
  exit 4
fi

META_FILE="$SESSION_DIR/meta.json"
STREAM_FILE="$SESSION_DIR/stream.jsonl"
STDERR_FILE="$SESSION_DIR/stderr.log"
TURN_FILE="$SESSION_DIR/turn.jsonl"   # temp: just this turn's output, merged in after
LOCK_FILE="$SESSION_DIR/turn.lock"

# ─── Gather agent + previous-turn context ─────────────────────────────────────
AGENT_PROMPT="$(jq -r '.agent_snapshot.prompt // ""' "$META_FILE")"
AGENT_CWD="$(jq -r '.agent_snapshot.cwd // ""' "$META_FILE")"
AGENT_ALLOWED_TOOLS="$(jq -r '(.agent_snapshot.allowedTools // []) | join(",")' "$META_FILE")"
TIMEOUT_SECONDS="$(jq -r '.agent_snapshot.timeout_seconds // 1800' "$META_FILE")"

# If the dashboard resolved and passed a merged allowlist, use it instead.
# "ALL" is a sentinel meaning no restriction (omit --allowedTools entirely).
if [[ "${ALLOWED_TOOLS_OVERRIDE:-}" == "ALL" ]]; then
  AGENT_ALLOWED_TOOLS=""
elif [[ -n "${ALLOWED_TOOLS_OVERRIDE:-}" ]]; then
  AGENT_ALLOWED_TOOLS="$ALLOWED_TOOLS_OVERRIDE"
fi

PREV_CLI="$(normalize_cli_id "$(jq -r '.turns[-1].cli // ""' "$META_FILE")")"
PREV_CLI_SESSION_ID="$(jq -r '.turns[-1].cli_session_id // ""' "$META_FILE")"
NUM_PRIOR_TURNS="$(jq -r '.turns | length' "$META_FILE")"

# ─── Decide: resume native session, or replay transcript ──────────────────────
RESUME_ID=""
IS_RESUME="no"
BUILD_TRANSCRIPT="no"

if [[ "$CLI" == "$PREV_CLI" && -n "$PREV_CLI_SESSION_ID" ]]; then
  RESUME_ID="$PREV_CLI_SESSION_ID"
  IS_RESUME="yes"
  PROMPT_TO_SEND="$USER_MESSAGE"
elif [[ "$NUM_PRIOR_TURNS" -gt 0 ]]; then
  # Switching CLI (or prior turn has no session id) — build a transcript replay
  BUILD_TRANSCRIPT="yes"
else
  # First turn — seed with agent prompt
  BUILD_TRANSCRIPT="first"
fi

# For claude engine, pre-generate a UUID so we can capture the session id on new sessions
NEW_SESSION_ID=""
if [[ "$ENGINE" == "claude" && -z "$RESUME_ID" ]]; then
  NEW_SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  RESUME_ID="$NEW_SESSION_ID"
  IS_RESUME="no"
fi

# ─── Task system instructions ─────────────────────────────────────────────────
# Always appended to the system/first-turn prompt so agents can use the task API.
TASK_INSTRUCTIONS=""
if [[ -n "${TASK_BASE_URL:-}" ]]; then
  TASK_INSTRUCTIONS="
---

## Shared Task Queue

You have access to a shared task/ticketing system. Use it to track work, coordinate with other agents, and avoid duplicate effort.

Base URL: ${TASK_BASE_URL}
Your identity (use as claimed_by): ${TASK_SESSION_ID:-unknown}

### Available operations (use Bash with curl):

\`\`\`
# List open tasks
curl -s \"${TASK_BASE_URL}?status=open&linked_session_id=${TASK_SESSION_ID:-unknown}\"

# Create a task
curl -s -X POST \"${TASK_BASE_URL}\" \\
  -H 'Content-Type: application/json' \\
  -d '{\"title\":\"...\",\"priority\":\"medium\",\"created_by\":\"${TASK_SESSION_ID:-agent}\",\"linked_session_id\":\"${TASK_SESSION_ID:-unknown}\"}'

# Claim a task (returns 409 if already taken by another agent)
curl -s -X POST \"${TASK_BASE_URL}/{id}/claim\" \\
  -H 'Content-Type: application/json' \\
  -d '{\"claimed_by\":\"${TASK_SESSION_ID:-agent}\"}'

# Update a task (status, notes, linked session)
curl -s -X PATCH \"${TASK_BASE_URL}/{id}\" \\
  -H 'Content-Type: application/json' \\
  -d '{\"status\":\"done\",\"notes\":\"...\",\"actor\":\"${TASK_SESSION_ID:-agent}\"}'

# Release a claim when done or handing off
curl -s -X POST \"${TASK_BASE_URL}/{id}/release\" \\
  -H 'Content-Type: application/json' \\
  -d '{\"claimed_by\":\"${TASK_SESSION_ID:-agent}\"}'
\`\`\`

Claim tasks before working on them. Release when done. If a claim returns 409, another agent is already working on it — pick a different task.

---"
fi

# Build the prompt text
if [[ "$BUILD_TRANSCRIPT" == "first" ]]; then
  if [[ -n "$AGENT_PROMPT" ]]; then
    PROMPT_TO_SEND="$AGENT_PROMPT$TASK_INSTRUCTIONS

---

User: $USER_MESSAGE"
  else
    PROMPT_TO_SEND="${TASK_INSTRUCTIONS:+${TASK_INSTRUCTIONS}$'\n\n'}$USER_MESSAGE"
  fi
elif [[ "$BUILD_TRANSCRIPT" == "yes" ]]; then
  TRANSCRIPT="$(jq -r '
    .turns
    | to_entries[]
    | .key as $idx
    | .value as $turn
    | "Turn \($idx + 1) [cli=\($turn.cli // "unknown"), status=\($turn.status // "unknown")]"
      + "\nUser: " + ($turn.user_message // "")
      + "\n\nAssistant: "
      + (if (($turn.final_text // "") | length) > 0
         then $turn.final_text
         else "[no final assistant response recorded; turn status was \($turn.status // "unknown")]"
         end)
  ' "$META_FILE")"
  AGENT_LINE=""
  [[ -n "$AGENT_PROMPT" ]] && AGENT_LINE="$AGENT_PROMPT

---

"
  PROMPT_TO_SEND="${AGENT_LINE}You are continuing an existing Saturn chat after a CLI/context switch.

You do not have native memory for this conversation. The transcript below is the authoritative prior context. Preserve prior conclusions, file paths, URLs, tool results, and stated next actions.

Important:
- The newest user request after the transcript is the active task.
- Do not restart an earlier task just because it appears in the transcript.
- If the newest user request says \"do this\", \"fix it\", or \"do all of this\", resolve that reference from the most recent non-empty assistant response in the transcript and then perform the requested work.
- If a prior turn was aborted or has no final response, treat it as incomplete context only.
- Before your final answer, sanity check that you are answering the newest user request, not replaying an older one.

Previous CLI: ${PREV_CLI:-unknown}
Current CLI: $CLI

Prior transcript:

$TRANSCRIPT

---

Newest user request:
$USER_MESSAGE"
fi

# ─── Mark session running + write turn stub immediately ───────────────────────
# Writing user_message now means a page refresh mid-stream will still show the
# user bubble while the assistant is still thinking.
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TURN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

jq --arg status "running" --arg started "$STARTED_AT" --arg turn_id "$TURN_ID" \
  --arg cli "$CLI" --arg model "$MODEL" --arg reasoning_effort "$REASONING_EFFORT" --arg user_msg "$USER_MESSAGE" \
  '.status = $status
  | .last_turn_started_at = $started
  | .turns += [{
      turn_id: $turn_id,
      cli: $cli,
      model: (if $model == "" then null else $model end),
      reasoningEffort: (if $reasoning_effort == "" then null else $reasoning_effort end),
      cli_session_id: null,
      started_at: $started,
      finished_at: null,
      status: "running",
      user_message: $user_msg,
      final_text: null
    }]' \
  "$META_FILE" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "$META_FILE"

jq -nc \
  --arg type "saturn.turn_start" \
  --arg session_id "$SESSION_ID" \
  --arg turn_id "$TURN_ID" \
  --arg started_at "$STARTED_AT" \
  --arg cli "$CLI" \
  --arg model "$MODEL" \
  '{type: $type, session_id: $session_id, turn_id: $turn_id, started_at: $started_at, cli: $cli, model: (if $model == "" then null else $model end)}' \
  >> "$STREAM_FILE"

# ─── cd into the agent's working directory ────────────────────────────────────
if [[ -n "$AGENT_CWD" && -d "$AGENT_CWD" ]]; then
  cd "$AGENT_CWD"
fi

# ─── Build CLI args + run ─────────────────────────────────────────────────────
build_cli_args "$CLI" "$MODEL" "$AGENT_ALLOWED_TOOLS" "$RESUME_ID" "$IS_RESUME" "$REASONING_EFFORT"

# If an MCP config was generated for this session (orchestrator), pass it to Claude
if [[ -n "${MCP_CONFIG_PATH:-}" && -f "$MCP_CONFIG_PATH" && "$ENGINE" == "claude" ]]; then
  RUN_ARGS+=(--mcp-config "$MCP_CONFIG_PATH")
fi

# Suppress all MCPs (global ~/.claude.json, plugins, cwd .mcp.json) for
# claude-local fast-prefill sessions. --mcp-config alone MERGES rather than
# replaces — --strict-mcp-config is required to actually exclude them.
if [[ "${STRICT_MCP:-}" == "1" && "$ENGINE" == "claude" ]]; then
  RUN_ARGS+=(--strict-mcp-config)
fi

# For claude-local sessions, write settings to a temp file to avoid shell quoting issues
if [[ -n "${CLAUDE_LOCAL_SETTINGS:-}" ]]; then
  _settings_tmp="$(mktemp -t claude-local-settings).json"
  printf '%s' "$CLAUDE_LOCAL_SETTINGS" > "$_settings_tmp"
  RUN_ARGS+=(--settings "$_settings_tmp")
fi

# Stream events live into STREAM_FILE (for SSE) and simultaneously capture to TURN_FILE
# so we can do post-processing (extract session id, final text) without re-reading the stream.
: > "$TURN_FILE"

# run_with_watchdog (from cli-dispatch.sh) dual-writes stdout to $TURN_FILE + stream
# when TURN_FILE is exported, and writes turn_pid/script_pid/cli_pgid to
# $CLI_PIDS_FILE while the CLI runs so the abort route can signal the whole
# CLI process group (which includes claude-code sub-agents, node workers, etc).
export TURN_FILE
export CLI_PIDS_FILE="$SESSION_DIR/pids.json"

run_with_watchdog "$TIMEOUT_SECONDS" "$STREAM_FILE" "$STDERR_FILE" "$PROMPT_TO_SEND"

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# TURN_FILE is now populated from the tee; STREAM_FILE already has the events live.

# ─── Extract CLI's native session id from its events ──────────────────────────
CLI_SESSION_ID=""
case "$ENGINE" in
  claude)
    # Claude stream-json emits a "system" init event with session_id=UUID
    CLI_SESSION_ID="$(jq -rs '
      [.[] | select(.type == "system" and .subtype == "init") | .session_id // empty] | last // empty
    ' "$TURN_FILE" 2>/dev/null || true)"
    [[ -z "$CLI_SESSION_ID" ]] && CLI_SESSION_ID="$NEW_SESSION_ID"
    ;;
  codex)
    # Codex emits {"type":"thread.started","thread_id":"UUID"}
    CLI_SESSION_ID="$(jq -rs '
      [.[] | select(.type == "thread.started") | .thread_id // empty] | last // empty
    ' "$TURN_FILE" 2>/dev/null || true)"
    ;;
esac

# ─── Extract final assistant text for transcript ──────────────────────────────
FINAL_TEXT=""
case "$ENGINE" in
  claude)
    # Extract text content; also check result.result for local thinking models
    FINAL_TEXT="$(jq -rs '
      [ .[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text | select(length > 0) ]
      | if length > 0 then .[-1]
        else ""
        end
    ' "$TURN_FILE" 2>/dev/null || true)"
    # Fallback: use result.result field (populated by Claude Code from local model output)
    if [[ -z "$FINAL_TEXT" ]]; then
      FINAL_TEXT="$(jq -rs '
        [ .[] | select(.type == "result") | .result // "" | select(length > 0) ] | last // ""
      ' "$TURN_FILE" 2>/dev/null || true)"
    fi
    ;;
  codex)
    # Codex exec emits {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    FINAL_TEXT="$(jq -rs '
      [.[] | select(.type == "item.completed") | .item | select(.type == "agent_message") | .text // ""]
      | if length > 0 then .[-1] else "" end
    ' "$TURN_FILE" 2>/dev/null || true)"
    ;;
esac

append_codex_generated_images() {
  [[ "$ENGINE" == "codex" ]] || return 0
  [[ -n "$CLI_SESSION_ID" ]] || return 0

  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local codex_session_file
  codex_session_file="$(
    find "$codex_home/sessions" -type f -name "*${CLI_SESSION_ID}.jsonl" -print 2>/dev/null | head -n 1
  )"
  [[ -n "$codex_session_file" && -f "$codex_session_file" ]] || return 0

  local generated_dir="generated"
  local generated_abs="$SESSION_DIR/$generated_dir"
  mkdir -p "$generated_abs"

  local b64 idx out rel image_markdown
  idx=0
  image_markdown=""

  while IFS= read -r b64; do
    [[ -n "$b64" ]] || continue
    idx=$((idx + 1))
    rel="$generated_dir/codex-${TURN_ID}-${idx}.png"
    out="$SESSION_DIR/$rel"
    if ! printf '%s' "$b64" | base64 --decode > "$out" 2>/dev/null; then
      printf '%s' "$b64" | base64 -D > "$out" 2>/dev/null || {
        rm -f "$out"
        continue
      }
    fi
    image_markdown="${image_markdown}${image_markdown:+$'\n\n'}![Generated image](${rel})"
  done < <(
    jq -rs --arg started "$STARTED_AT" --arg finished "$FINISHED_AT" -r '
      def to_epoch:
        sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601? // 0;

      ($started | to_epoch) as $start
      | ($finished | to_epoch) as $finish
      | [
          .[]
          | select(((.timestamp // "") | to_epoch) >= $start and ((.timestamp // "") | to_epoch) <= ($finish + 10))
          | .payload? as $payload
          | select(($payload.type == "image_generation_end" or $payload.type == "image_generation_call"))
          | $payload.result? // ""
          | select(type == "string" and length > 100)
        ]
      | unique[]
    ' "$codex_session_file" 2>/dev/null || true
  )

  [[ -n "$image_markdown" ]] || return 0

  jq -nc --arg text "$image_markdown" '
    {type: "item.completed", item: {id: "saturn_generated_images", type: "agent_message", text: $text}}
  ' >> "$STREAM_FILE"

  if [[ -n "$FINAL_TEXT" ]]; then
    FINAL_TEXT="${FINAL_TEXT}"$'\n\n'"${image_markdown}"
  else
    FINAL_TEXT="$image_markdown"
  fi
}

append_codex_generated_images

# Fallback to last assistant text across any format
if [[ -z "$FINAL_TEXT" ]]; then
  FINAL_TEXT="$(jq -rs 'last // "" | if type == "object" then (.text // "") else "" end' "$TURN_FILE" 2>/dev/null || true)"
fi

# ─── Update meta.json: fill in the turn stub written at start ────────────────
EXIT_CODE="${EXIT_CODE:-0}"
STATUS="success"
[[ "$EXIT_CODE" -ne 0 ]] && STATUS="failed"

jq \
  --arg turn_id "$TURN_ID" \
  --arg cli "$CLI" \
  --arg model "$MODEL" \
  --arg reasoning_effort "$REASONING_EFFORT" \
  --arg session_id "$CLI_SESSION_ID" \
  --arg started "$STARTED_AT" \
  --arg finished "$FINISHED_AT" \
  --arg user_msg "$USER_MESSAGE" \
  --arg final "$FINAL_TEXT" \
  --arg status "$STATUS" \
  '.turns[-1] = {
      turn_id: $turn_id,
      cli: $cli,
      model: (if $model == "" then null else $model end),
      reasoningEffort: (if $reasoning_effort == "" then null else $reasoning_effort end),
      cli_session_id: (if $session_id == "" then null else $session_id end),
      started_at: $started,
      finished_at: $finished,
      status: $status,
      user_message: $user_msg,
      final_text: $final
    }
    | .status = $status
    | .finished_at = $finished
    | del(.last_turn_started_at)' \
  "$META_FILE" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "$META_FILE"

# Write final.md for the session (latest assistant reply)
printf '%s\n' "$FINAL_TEXT" > "$SESSION_DIR/final.md"

# Cleanup
rm -f "$TURN_FILE"

exit "$EXIT_CODE"
