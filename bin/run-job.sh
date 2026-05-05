#!/bin/bash
# run-job.sh <job-name>
# Invoked by cron. Reads the named job from jobs/jobs.json, runs the selected CLI in
# --print --output-format stream-json mode, and writes artifacts to
# runs/<job-name>/<iso-ts>/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

JOBS_FILE="$AUTOMATIONS_ROOT/jobs/jobs.json"
RUNS_ROOT="$AUTOMATIONS_ROOT/runs"

# shellcheck source=lib/cli-dispatch.sh
source "$AUTOMATIONS_ROOT/bin/lib/cli-dispatch.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: run-job.sh <job-name>  |  run-job.sh --agent <agent-id>" >&2
  exit 2
fi

RETRY_ATTEMPT="${SATURN_JOB_RETRY_ATTEMPT:-0}"
RETRY_OF="${SATURN_JOB_RETRY_OF:-}"
RETRY_DELAY_SECONDS="${SATURN_JOB_RETRY_DELAY_SECONDS:-1800}"
if [[ ! "$RETRY_ATTEMPT" =~ ^[0-9]+$ ]]; then
  RETRY_ATTEMPT="0"
fi
if [[ ! "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ || "$RETRY_DELAY_SECONDS" -lt 1 ]]; then
  RETRY_DELAY_SECONDS="1800"
fi

if [[ "$1" == "--agent" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "usage: run-job.sh --agent <agent-id>" >&2
    exit 2
  fi
  JOB_MODE="agent"
  AGENT_ID="$2"
  saturn_validate_path_segment "$AGENT_ID" "agent id"
  JOB_NAME="agent-$AGENT_ID"
  AGENTS_FILE="$AUTOMATIONS_ROOT/agents.json"
  JOB_JSON="$(jq --arg id "$AGENT_ID" '.agents[]? | select(.id == $id)' "$AGENTS_FILE" 2>/dev/null)"
  if [[ -z "$JOB_JSON" || "$JOB_JSON" == "null" ]]; then
    echo "run-job: no agent with id '$AGENT_ID' in $AGENTS_FILE" >&2
    exit 3
  fi
else
  JOB_MODE="job"
  JOB_NAME="$1"
  saturn_validate_path_segment "$JOB_NAME" "job name"
  JOB_JSON="$(jq --arg n "$JOB_NAME" '.jobs[] | select(.name == $n)' "$JOBS_FILE")"
  if [[ -z "$JOB_JSON" || "$JOB_JSON" == "null" ]]; then
    echo "run-job: no job named '$JOB_NAME' in $JOBS_FILE" >&2
    exit 3
  fi
fi

PROMPT="$(jq -r '.prompt' <<<"$JOB_JSON")"
CWD="$(jq -r '.cwd // empty' <<<"$JOB_JSON")"
ALLOWED_TOOLS="$(jq -r '.allowedTools // [] | join(",")' <<<"$JOB_JSON")"
CRON_EXPR="$(jq -r '.cron // ""' <<<"$JOB_JSON")"
MODEL="$(jq -r '.model // empty' <<<"$JOB_JSON")"
REASONING_EFFORT="$(jq -r '.reasoningEffort // empty' <<<"$JOB_JSON")"
CLI="$(normalize_cli_id "$(jq -r '.cli // "claude-bedrock"' <<<"$JOB_JSON")")"  # claude-bedrock | claude-personal | claude-local | codex
TIMEOUT_SECONDS="$(jq -r '.timeout_seconds // 1800' <<<"$JOB_JSON")"
saturn_validate_timeout_seconds "$TIMEOUT_SECONDS" "timeout_seconds"

JOB_UI_INSTRUCTIONS="$(cat <<'EOF'

---

Saturn job output can include a dynamic dashboard block. When the final answer contains structured status, counts, links, or records that would be clearer as UI, include one fenced `saturn-ui` JSON block in addition to any human-readable Markdown.

Supported shape:
```saturn-ui
{
  "title": "Short result title",
  "summary": "One sentence summary.",
  "metrics": [{"label": "Open items", "value": "4", "tone": "warn", "delta": "2 new"}],
  "links": [{"label": "Open report", "href": "/runs/job/slug", "description": "Optional"}],
  "charts": [{
    "title": "Trend",
    "type": "bar",
    "xKey": "day",
    "series": [{"key": "count", "label": "Count", "tone": "accent"}],
    "data": [{"day": "Mon", "count": 3}, {"day": "Tue", "count": 7}]
  }],
  "sections": [{"title": "Notes", "items": ["First", "Second"]}],
  "tables": [{
    "title": "Items",
    "columns": [{"key": "name", "label": "Name"}, {"key": "status", "label": "Status"}],
    "rows": [{"name": "Example", "status": "Ready"}]
  }]
}
```

Use only data that belongs in the job result. Do not put secrets in this block.
EOF
)"
PROMPT="${PROMPT}${JOB_UI_INSTRUCTIONS}"

TS="$(date +%Y-%m-%dT%H-%M-%S)"
RUN_DIR="$RUNS_ROOT/$JOB_NAME/$TS"
mkdir -p "$RUN_DIR"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date +%s)"

jq -n \
  --arg name "$JOB_NAME" \
  --arg slug "$TS" \
  --arg cron "$CRON_EXPR" \
  --arg started_at "$STARTED_AT" \
  --arg status "running" \
  --arg model "${MODEL:-}" \
  --arg reasoning_effort "${REASONING_EFFORT:-}" \
  --arg cli "${CLI:-claude-bedrock}" \
  --argjson retry_attempt "$RETRY_ATTEMPT" \
  --arg retry_of "$RETRY_OF" \
  '{
    name: $name,
    slug: $slug,
    cron: $cron,
    started_at: $started_at,
    status: $status,
    model: (if $model == "" then null else $model end),
    reasoningEffort: (if $reasoning_effort == "" then null else $reasoning_effort end),
    cli: $cli,
    retry_attempt: $retry_attempt
  } + (if $retry_of == "" then {} else {retry_of: $retry_of} end)' \
  > "$RUN_DIR/meta.json"

schedule_failed_retry() {
  local scheduled_epoch scheduled_at script
  scheduled_epoch=$(( $(date +%s) + RETRY_DELAY_SECONDS ))
  scheduled_at="$(date -u -r "$scheduled_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$scheduled_epoch" +%Y-%m-%dT%H:%M:%SZ)"
  script="$AUTOMATIONS_ROOT/bin/run-job.sh"

  if [[ "$JOB_MODE" == "agent" ]]; then
    nohup env SATURN_JOB_RETRY_ATTEMPT=1 SATURN_JOB_RETRY_OF="$TS" \
      bash -c 'sleep "$1"; shift; exec "$@"' retry-delay "$RETRY_DELAY_SECONDS" "$script" --agent "$AGENT_ID" \
      >> "$RUNS_ROOT/cron.log" 2>&1 &
  else
    nohup env SATURN_JOB_RETRY_ATTEMPT=1 SATURN_JOB_RETRY_OF="$TS" \
      bash -c 'sleep "$1"; shift; exec "$@"' retry-delay "$RETRY_DELAY_SECONDS" "$script" "$JOB_NAME" \
      >> "$RUNS_ROOT/cron.log" 2>&1 &
  fi

  printf '%s' "$scheduled_at"
}

if [[ -n "$CWD" && -d "$CWD" ]]; then
  cd "$CWD"
fi

# Build CLI-specific args (populates RUN_ARGS + RUN_CMD)
build_cli_args "${CLI:-claude-bedrock}" "$MODEL" "$ALLOWED_TOOLS" "" "run" "$REASONING_EFFORT"

append_plugin_mcp_config_arg "$CLI" "$RUN_DIR/plugin-mcp-config.json" "$RUN_DIR/stderr.log"
append_claude_local_settings_arg

# Run the CLI with watchdog-enforced timeout (sets EXIT_CODE)
run_with_watchdog "$TIMEOUT_SECONDS" "$RUN_DIR/stream.jsonl" "$RUN_DIR/stderr.log" "$PROMPT"

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINISHED_EPOCH="$(date +%s)"
DURATION_MS=$(( (FINISHED_EPOCH - STARTED_EPOCH) * 1000 ))

# Extract final.md and stats — format differs by CLI
TOTAL_TOKENS=0
NUM_TURNS=0

if [[ "$CLI" == "codex" ]]; then
  # Codex JSONL: {"type":"agent.message","role":"assistant","content":"..."}
  jq -rs '
    [ .[] | select(.type == "agent.message" and .role == "assistant") | .content ] as $msgs |
    if ($msgs | length) > 0 then $msgs[-1]
    else
      [ .[] | select(.type == "turn.completed") | .output[]? | select(.role == "assistant") | .content[]? | select(.type == "text") | .text ] | last // ""
    end
  ' "$RUN_DIR/stream.jsonl" 2>/dev/null > "$RUN_DIR/final.md" || true
  NUM_TURNS="$(jq -rs '[.[] | select(.type == "turn.started")] | length' "$RUN_DIR/stream.jsonl" 2>/dev/null || echo 0)"
  # Codex token extraction from turn.completed usage
  RESULT_JSON="$(jq -c 'select(.type == "turn.completed") | .' "$RUN_DIR/stream.jsonl" 2>/dev/null | tail -n 1 || true)"
  if [[ -n "$RESULT_JSON" ]]; then
    TOTAL_TOKENS="$(jq -r '
      .usage // {} |
      (.input_tokens // 0) +
      (.output_tokens // 0) +
      (.cached_input_tokens // 0) +
      (.reasoning_output_tokens // 0)
    ' <<<"$RESULT_JSON" 2>/dev/null || echo 0)"
  fi
else
  # Claude stream-json format
  jq -rs '
    [ .[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text ]
    | if length == 0 then ""
      elif length == 1 then .[0]
      else .[-1]
      end
  ' "$RUN_DIR/stream.jsonl" 2>/dev/null > "$RUN_DIR/final.md" || true

  # Take the last result event — Claude's is cumulative, others are per-turn
  RESULT_JSON="$(jq -c 'select(.type == "result") | .' "$RUN_DIR/stream.jsonl" 2>/dev/null | tail -n 1 || true)"
  RESULT_TEXT=""
  if [[ -n "$RESULT_JSON" ]]; then
    # Canonical token extraction — mirrors tokenBreakdownFromRaw() in lib/events.ts.
    # Handles: Claude (cache_creation_input_tokens may be object or number,
    #          cache_read_input_tokens), Codex (cached_input_tokens,
    #          reasoning_output_tokens), plus reasoning for all.
    TOTAL_TOKENS="$(jq -r '
      .usage // {} |
      (.input_tokens // 0) +
      (.output_tokens // 0) +
      (if (.cache_creation_input_tokens | type) == "number"
        then .cache_creation_input_tokens
        else (.cache_creation_input_tokens // {} | to_entries | map(.value | numbers) | add // 0)
        end) +
      (.cache_read_input_tokens // .cached_input_tokens // 0) +
      (.reasoning_output_tokens // 0)
    ' <<<"$RESULT_JSON" 2>/dev/null || echo 0)"
    NUM_TURNS="$(jq -r '.num_turns // 0' <<<"$RESULT_JSON" 2>/dev/null || echo 0)"
    RESULT_TEXT="$(jq -r '.result // ""' <<<"$RESULT_JSON" 2>/dev/null || echo "")"
  fi

  if [[ ! -s "$RUN_DIR/final.md" && -n "$RESULT_TEXT" ]]; then
    printf '%s\n' "$RESULT_TEXT" > "$RUN_DIR/final.md"
  fi
fi

STATUS="success"
[[ "$EXIT_CODE" -ne 0 ]] && STATUS="failed"

RETRY_SCHEDULED_AT=""
if [[ "$STATUS" == "failed" && "$RETRY_ATTEMPT" -eq 0 ]]; then
  RETRY_SCHEDULED_AT="$(schedule_failed_retry)"
fi

jq -n \
  --arg name "$JOB_NAME" \
  --arg slug "$TS" \
  --arg cron "$CRON_EXPR" \
  --arg started_at "$STARTED_AT" \
  --arg finished_at "$FINISHED_AT" \
  --arg status "$STATUS" \
  --argjson exit_code "$EXIT_CODE" \
  --argjson duration_ms "$DURATION_MS" \
  --argjson total_tokens "${TOTAL_TOKENS:-0}" \
  --argjson num_turns "${NUM_TURNS:-0}" \
  --arg model "${MODEL:-}" \
  --arg reasoning_effort "${REASONING_EFFORT:-}" \
  --arg cli "${CLI:-claude-bedrock}" \
  --argjson retry_attempt "$RETRY_ATTEMPT" \
  --arg retry_of "$RETRY_OF" \
  --arg retry_scheduled_at "$RETRY_SCHEDULED_AT" \
  --argjson retry_after_seconds "$RETRY_DELAY_SECONDS" \
  '{
    name: $name,
    slug: $slug,
    cron: $cron,
    started_at: $started_at,
    finished_at: $finished_at,
    status: $status,
    exit_code: $exit_code,
    duration_ms: $duration_ms,
    total_tokens: $total_tokens,
    num_turns: $num_turns,
    model: (if $model == "" then null else $model end),
    reasoningEffort: (if $reasoning_effort == "" then null else $reasoning_effort end),
    cli: $cli,
    retry_attempt: $retry_attempt
  }
  + (if $retry_of == "" then {} else {retry_of: $retry_of} end)
  + (if $retry_scheduled_at == "" then {} else {retry_scheduled_at: $retry_scheduled_at, retry_after_seconds: $retry_after_seconds} end)' \
  > "$RUN_DIR/meta.json"

exit "$EXIT_CODE"
