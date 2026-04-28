#!/bin/bash
# Bootstrap a fresh Saturn checkout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

RUN_NPM=1
RUN_BUILD=1
INSTALL_CLAUDE_LOCAL=1

usage() {
  cat <<'USAGE'
usage: bin/bootstrap.sh [options]

Options:
  --skip-npm             Do not run npm install in dashboard/
  --skip-build           Do not run npm run build in dashboard/
  --no-claude-local      Do not create ~/bin/claude-local or ~/litellm_config.yaml
  -h, --help             Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-npm) RUN_NPM=0 ;;
    --skip-build) RUN_BUILD=0 ;;
    --no-claude-local) INSTALL_CLAUDE_LOCAL=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "bootstrap: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

copy_if_missing() {
  local src="$1"
  local dst="$2"
  if [[ -e "$dst" ]]; then
    echo "keep $dst"
  else
    cp "$src" "$dst"
    echo "create $dst"
  fi
}

write_dashboard_env() {
  local env_file="$AUTOMATIONS_ROOT/dashboard/.env.local"
  local value
  value="$(saturn_env_double_quote "$AUTOMATIONS_ROOT")"

  if [[ ! -f "$env_file" ]] || grep -q '/absolute/path/to/saturn_agent_harness' "$env_file"; then
    printf 'AUTOMATIONS_ROOT=%s\n' "$value" > "$env_file"
    echo "write $env_file"
  else
    echo "keep $env_file"
  fi
}

install_claude_local() {
  mkdir -p "$HOME/bin"

  local config="$HOME/litellm_config.yaml"
  if [[ ! -f "$config" ]]; then
    cat > "$config" <<'YAML'
model_list:
  # LM Studio local models. Edit these model_name values to match the models
  # exposed by http://127.0.0.1:1234/v1/models on your machine.
  - model_name: gemma4:26b-it-q4_K_M
    litellm_params:
      model: openai/gemma4:26b-it-q4_K_M
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: gemma4:4b
    litellm_params:
      model: openai/gemma4:4b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: qwen/qwen3.6-27b
    litellm_params:
      model: openai/qwen/qwen3.6-27b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: nvidia/nemotron-3-nano
    litellm_params:
      model: openai/nvidia/nemotron-3-nano
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
  - model_name: google/gemma-4-26b-a4b
    litellm_params:
      model: openai/google/gemma-4-26b-a4b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio

general_settings:
  master_key: sk-local-proxy-key
YAML
    echo "create $config"
  else
    echo "keep $config"
  fi

  cat > "$HOME/bin/claude-local" <<'BASH'
#!/bin/bash
set -euo pipefail

LITELLM_PORT="${LITELLM_PORT:-4000}"
LITELLM_CONFIG="${LITELLM_CONFIG:-$HOME/litellm_config.yaml}"
LITELLM_KEY="${LITELLM_KEY:-sk-local-proxy-key}"

_litellm_ready() {
  curl -sf -H "Authorization: Bearer ${LITELLM_KEY}" \
    "http://127.0.0.1:${LITELLM_PORT}/health" >/dev/null 2>&1
}

if ! _litellm_ready; then
  lsof -ti tcp:${LITELLM_PORT} | xargs kill -9 2>/dev/null || true
  sleep 1
  echo "[claude-local] Starting LiteLLM proxy on port ${LITELLM_PORT}..."
  "${LITELLM_BIN:-$HOME/.local/bin/litellm}" --config "$LITELLM_CONFIG" --port "$LITELLM_PORT" \
    >/tmp/litellm.log 2>&1 &
  for _ in $(seq 1 20); do
    sleep 1
    if _litellm_ready; then
      echo "[claude-local] LiteLLM ready."
      break
    fi
  done
fi

exec env \
  CLAUDE_CODE_USE_BEDROCK="" \
  CLAUDE_CODE_USE_VERTEX="" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:${LITELLM_PORT}" \
  ANTHROPIC_AUTH_TOKEN="${LITELLM_KEY}" \
  ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-gemma4:26b-it-q4_K_M}" \
  ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-gemma4:4b}" \
  claude "$@"
BASH
  chmod +x "$HOME/bin/claude-local"
  echo "write $HOME/bin/claude-local"
}

echo "Saturn root: $AUTOMATIONS_ROOT"

if ! saturn_require_command git node npm jq; then
  cat >&2 <<'MSG'

Install the missing required commands, then re-run bootstrap.
On macOS with Homebrew, this is usually:
  brew install node jq git
MSG
  exit 1
fi

mkdir -p "$AUTOMATIONS_ROOT/runs" "$AUTOMATIONS_ROOT/sessions" "$AUTOMATIONS_ROOT/tasks" "$AUTOMATIONS_ROOT/telegram" "$AUTOMATIONS_ROOT/slice-fixtures"

copy_if_missing "$AUTOMATIONS_ROOT/settings.example.json" "$AUTOMATIONS_ROOT/settings.json"
copy_if_missing "$AUTOMATIONS_ROOT/agents.example.json" "$AUTOMATIONS_ROOT/agents.json"
copy_if_missing "$AUTOMATIONS_ROOT/slices.example.json" "$AUTOMATIONS_ROOT/slices.json"
copy_if_missing "$AUTOMATIONS_ROOT/mcps.example.json" "$AUTOMATIONS_ROOT/mcps.json"
copy_if_missing "$AUTOMATIONS_ROOT/working-directories.example.json" "$AUTOMATIONS_ROOT/working-directories.json"
copy_if_missing "$AUTOMATIONS_ROOT/jobs/jobs.example.json" "$AUTOMATIONS_ROOT/jobs/jobs.json"
write_dashboard_env

chmod +x "$AUTOMATIONS_ROOT"/bin/*.sh "$AUTOMATIONS_ROOT"/bin/*.mjs "$AUTOMATIONS_ROOT"/bin/lib/pgid_shim.py

if [[ "$INSTALL_CLAUDE_LOCAL" == "1" ]]; then
  install_claude_local
fi

if [[ "$RUN_NPM" == "1" ]]; then
  (cd "$AUTOMATIONS_ROOT/dashboard" && npm install)
fi

if [[ "$RUN_BUILD" == "1" ]]; then
  (cd "$AUTOMATIONS_ROOT/dashboard" && npm run build)
fi

cat <<MSG

Bootstrap complete.

Next:
  1. Start the dashboard now:
     cd "$AUTOMATIONS_ROOT/dashboard" && AUTOMATIONS_ROOT="$AUTOMATIONS_ROOT" npm run dev

  2. Or install it as a launchd service:
     "$AUTOMATIONS_ROOT/bin/install-dashboard-service.sh"

  3. Configure auth for the backend you want:
     - Bedrock: aws sso login --profile \${AWS_PROFILE:-sondermind-development-new}
     - Personal Claude: open Settings in Saturn, or select Personal and run /login
     - Local Claude: start LM Studio on 127.0.0.1:1234, then use claude-local
     - Codex: run codex once and sign in if needed
MSG
