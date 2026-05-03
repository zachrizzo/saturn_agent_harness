#!/bin/bash
# cli-dispatch.sh — shared helpers for invoking Claude Code or Codex.
#
# Sourced by run-job.sh (one-shot cron runs) and run-turn.sh (chat turns).
# Expects AUTOMATIONS_ROOT to be set by the caller.

# ─── Bedrock model alias expansion ───────────────────────────────────────────
# Reads the canonical alias→bedrockId table from
# dashboard/lib/claude-models.json (shared with toBedrockId() in TS).
# Returns the input unchanged if already fully-qualified or unknown.
to_bedrock_id() {
  local model="$1"
  case "$model" in
    global.*|us.*|*anthropic.claude*) echo "$model"; return 0 ;;
  esac
  local repo_root="${SATURN_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  local table="$repo_root/dashboard/lib/claude-models.json"
  if [[ ! -f "$table" ]]; then
    echo "$model"
    return 0
  fi
  node - "$table" "$model" <<'NODE' 2>/dev/null || echo "$model"
const fs = require("fs");
const [, , tablePath, alias] = process.argv;
try {
  const data = JSON.parse(fs.readFileSync(tablePath, "utf8"));
  const found = (data.models || []).find((m) => m && m.alias === alias);
  process.stdout.write(found?.bedrockId || alias);
} catch {
  process.stdout.write(alias);
}
NODE
}

# ─── Bedrock env setup ───────────────────────────────────────────────────────
# Sets CLAUDE_CODE_USE_BEDROCK + AWS env vars needed for Bedrock-backed Claude.
# Called by build_cli_args for the "claude-bedrock" case.
# Callers that already inject these env vars (e.g. turn.ts via Node) are safe
# to call this again — it only overrides when not already set.
setup_bedrock_env() {
  export CLAUDE_CODE_USE_BEDROCK="${CLAUDE_CODE_USE_BEDROCK:-1}"
  export AWS_PROFILE="${AWS_PROFILE:-sondermind-development-new}"
  export AWS_REGION="${AWS_REGION:-us-east-1}"
}

shell_join_quoted() {
  local out="" quoted arg
  for arg in "$@"; do
    printf -v quoted "%q" "$arg"
    if [[ -n "$out" ]]; then
      out+=" $quoted"
    else
      out="$quoted"
    fi
  done
  printf '%s' "$out"
}

bedrock_settings_json() {
  local profile="${AWS_PROFILE:-sondermind-development-new}"
  local region="${AWS_REGION:-us-east-1}"
  local refresh_cmd
  refresh_cmd="$(shell_join_quoted "$AUTOMATIONS_ROOT/bin/bedrock-auth-refresh.sh" "$profile" "$region")"

  jq -nc \
    --arg refresh "$refresh_cmd" \
    --arg profile "$profile" \
    --arg region "$region" \
    '{
      awsAuthRefresh: $refresh,
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: $profile,
        AWS_REGION: $region
      }
    }'
}

prefer_plugin_mcp_servers() {
  local config_path="$1"
  if [[ ! -f "$config_path" ]]; then
    return 0
  fi

  # Claude Code 2.1.x auto-loads claude.ai connectors and then suppresses
  # plugin MCP servers it thinks duplicate those connectors. For Figma and
  # Slack, the plugin-auth server is the connected one in print turns, so keep
  # plugin MCPs visible by disabling automatic claude.ai connector loading.
  if jq -e '
    (.mcpServers // {}) | keys[] | select(. == "plugin:figma:figma" or . == "plugin:slack:slack")
  ' "$config_path" >/dev/null 2>&1; then
    export ENABLE_CLAUDEAI_MCP_SERVERS="${ENABLE_CLAUDEAI_MCP_SERVERS:-0}"
  fi
}

normalize_cli_id() {
  case "${1:-}" in
    claude|"")       echo "claude-bedrock" ;;
    claude-bedrock|claude-personal|claude-local|codex) echo "$1" ;;
    *)              echo "$1" ;;
  esac
}

claude_reasoning_efforts() {
  local line levels
  line="$(claude --help 2>&1 | awk '/--effort/{ print; exit }' || true)"
  levels="$(printf '%s\n' "$line" | sed -n 's/.*(\([^)]*\)).*/\1/p')"
  [[ -n "$levels" ]] || return 1
  printf '%s\n' "$levels" \
    | tr ',|/' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | awk 'NF'
}

claude_effort_supported() {
  local effort="$1"
  local level
  while IFS= read -r level; do
    [[ "$level" == "$effort" ]] && return 0
  done < <(claude_reasoning_efforts)
  return 1
}

codex_effort_supported() {
  local model="$1"
  local effort="$2"
  [[ -n "$effort" ]] || return 1
  node - "$model" "$effort" <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

let model = process.argv[2];
const effort = process.argv[3];
const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
const configPath = path.join(os.homedir(), ".codex", "config.toml");

try {
  if (!model) {
    const config = fs.readFileSync(configPath, "utf8");
    model = config.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  }
  if (!model) process.exit(1);
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const found = (parsed.models || []).find((entry) => entry && entry.slug === model);
  const levels = Array.isArray(found && found.supported_reasoning_levels)
    ? found.supported_reasoning_levels
        .map((level) => typeof level === "string" ? level : level && level.effort)
        .filter(Boolean)
    : [];
  process.exit(levels.includes(effort) ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

# ─── Build args for each CLI ─────────────────────────────────────────────────
# Populates the RUN_ARGS array and RUN_CMD variable in the caller's scope.
#
# Args (positional):
#   $1 cli              - "claude-bedrock" | "claude-personal" | "claude-local" | "codex" ("claude" aliases to claude-bedrock)
#   $2 model            - model id or empty
#   $3 allowed_tools    - comma-separated (claude only), __SATURN_NO_TOOLS__, or empty
#   $4 session_id       - CLI-native session id; use with $5 to distinguish resume vs new
#   $5 is_resume        - "yes" to resume an existing session, anything else to start fresh
#   $6 reasoning_effort - optional thinking/reasoning level
build_cli_args() {
  local cli
  cli="$(normalize_cli_id "$1")"
  local model="$2"
  local allowed_tools="$3"
  local session_id="$4"
  local is_resume="${5:-no}"
  local reasoning_effort="${6:-}"

  RUN_ARGS=()

  case "$cli" in
    codex)
      export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
      if [[ -n "$session_id" && "$is_resume" == "yes" ]]; then
        RUN_ARGS+=(exec resume "$session_id")
      else
        RUN_ARGS+=(exec)
      fi
      RUN_ARGS+=(
        --json
        --skip-git-repo-check
        --dangerously-bypass-approvals-and-sandbox
      )
      [[ -n "$model" ]] && RUN_ARGS+=(-m "$model")
      if [[ -n "$reasoning_effort" ]] && codex_effort_supported "$model" "$reasoning_effort"; then
        RUN_ARGS+=(--config "model_reasoning_effort=\"$reasoning_effort\"")
      fi
      RUN_CMD="codex"
      ;;

    claude-bedrock|claude-personal|claude-local)  # Claude Code binary
      # --print has no TTY to answer permission prompts, so normal turns bypass.
      # Native slash handlers can set CLAUDE_PERMISSION_MODE=plan for plan mode.
      RUN_ARGS+=(
        --print
        --output-format stream-json
        --verbose
      )
      if [[ -n "${CLAUDE_PERMISSION_MODE:-}" ]]; then
        RUN_ARGS+=(--permission-mode "$CLAUDE_PERMISSION_MODE")
      else
        RUN_ARGS+=(--dangerously-skip-permissions)
      fi
      if [[ -n "$session_id" ]]; then
        if [[ "$is_resume" == "yes" ]]; then
          RUN_ARGS+=(--resume "$session_id")
        else
          RUN_ARGS+=(--session-id "$session_id")
        fi
      fi

      local resolved_model
      if [[ "$cli" == "claude-bedrock" ]]; then
        # Expand short model alias → full Bedrock inference profile ID.
        resolved_model="$(to_bedrock_id "${model:-}")"
      else
        resolved_model="${model:-}"
      fi
      if [[ ",$allowed_tools," == *",__SATURN_NO_TOOLS__,"* ]]; then
        RUN_ARGS+=(--tools "")
      elif [[ -n "$allowed_tools" ]]; then
        RUN_ARGS+=(--allowedTools "$allowed_tools")
      fi
      [[ -n "$resolved_model" ]] && RUN_ARGS+=(--model "$resolved_model")
      if [[ -n "$reasoning_effort" ]] && claude_effort_supported "$reasoning_effort"; then
        RUN_ARGS+=(--effort "$reasoning_effort")
      fi
      RUN_CMD="claude"

      if [[ "$cli" == "claude-local" ]]; then
        export CLAUDE_CODE_USE_BEDROCK="0"
        export ANTHROPIC_BASE_URL="http://0.0.0.0:4000"
        export ANTHROPIC_AUTH_TOKEN="sk-local-proxy-key"
      elif [[ "$cli" == "claude-personal" ]]; then
        unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
        RUN_ARGS+=(--setting-sources "${CLAUDE_SETTING_SOURCES:-project,local}")
      else
        # Bedrock (or default) path — inject AWS auth if not already set.
        setup_bedrock_env
        if [[ "${SATURN_BEDROCK_AUTH_REFRESH:-1}" != "0" ]]; then
          RUN_ARGS+=(--settings "$(bedrock_settings_json)")
        fi
      fi
      ;;
    *)
      echo "unsupported CLI: $cli" >&2
      return 2
      ;;
  esac
}

# ─── Watchdog-run a CLI ──────────────────────────────────────────────────────
# Runs the CLI configured in RUN_CMD + RUN_ARGS (set by build_cli_args) as the
# leader of a fresh process group via bin/lib/pgid_shim.py, so the abort route
# and the watchdog below can reach the CLI + every descendant (sub-agents,
# node workers, LM Studio subprocesses) with one kill -<cli_pgid>.
#
# Usage:
#   run_with_watchdog <timeout_seconds> <stream_out> <stderr_out> <prompt_text>
#
# Optional caller env:
#   TURN_FILE       — if set, the shim dual-writes stdout to this file *and*
#                     <stream_out>.  Used by run-turn.sh so a later post-pass
#                     can parse the CLI's events without re-reading the SSE
#                     stream.  Pass empty / unset to skip the extra write.
#   CLI_PIDS_FILE   — if set, a JSON pids record is written here with
#                     turn_pid / script_pid / cli_pgid, and removed on exit.
#
# Sets EXIT_CODE in the caller's scope.
run_with_watchdog() {
  local timeout_s="$1"
  local stream_out="$2"
  local stderr_out="$3"
  local prompt="$4"

  local prompt_file
  prompt_file="$(mktemp -t cli-dispatch-prompt).txt"
  printf '%s' "$prompt" > "$prompt_file"

  # The shim takes four output paths: STDIN, TURN, STREAM, STDERR.
  # When the caller doesn't want a turn-buffer, point TURN at /dev/null.
  local turn_path="${TURN_FILE:-/dev/null}"

  set +e
  "$AUTOMATIONS_ROOT/bin/lib/pgid_shim.py" \
    "$prompt_file" "$turn_path" "$stream_out" "$stderr_out" \
    -- "$RUN_CMD" "${RUN_ARGS[@]}" &
  local child_pid=$!

  # The shim calls setpgrp() very early; poll briefly for the new pgid to
  # stabilize in case scheduler jitter delays it.
  local cli_pgid="$child_pid"
  local i p
  for i in 1 2 3 4 5; do
    p="$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d ' ')"
    if [[ -n "$p" && "$p" == "$child_pid" ]]; then
      cli_pgid="$p"
      break
    fi
    sleep 0.05
  done

  if [[ -n "${CLI_PIDS_FILE:-}" ]]; then
    printf '{"turn_pid":%d,"script_pid":%d,"cli_pgid":%d,"started_at":"%s"}\n' \
      "$child_pid" "$$" "$cli_pgid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$CLI_PIDS_FILE"
  fi

  (
    sleep "$timeout_s"
    if kill -0 "$child_pid" 2>/dev/null; then
      echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) timeout after ${timeout_s}s — killing pgid $cli_pgid" >> "$stderr_out"
      kill -TERM -"$cli_pgid" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null
      sleep 5
      kill -KILL -"$cli_pgid" 2>/dev/null || kill -KILL "$child_pid" 2>/dev/null
    fi
  ) &
  local wd_pid=$!

  wait "$child_pid"
  EXIT_CODE=$?
  kill "$wd_pid" 2>/dev/null
  wait "$wd_pid" 2>/dev/null
  [[ -n "${CLI_PIDS_FILE:-}" ]] && rm -f "$CLI_PIDS_FILE" 2>/dev/null
  rm -f "$prompt_file" 2>/dev/null || true
  set -e
}
