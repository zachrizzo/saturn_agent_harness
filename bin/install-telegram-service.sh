#!/bin/bash
# Generate and load the optional Telegram Dispatch LaunchAgent.
#
# Required:
#   TELEGRAM_BOT_TOKEN
#   TELEGRAM_ALLOWED_CHAT_IDS or TELEGRAM_ALLOW_ALL=1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "Set TELEGRAM_BOT_TOKEN before running this installer." >&2
  exit 2
fi
if [[ -z "${TELEGRAM_ALLOWED_CHAT_IDS:-}" && "${TELEGRAM_ALLOW_ALL:-}" != "1" ]]; then
  echo "Set TELEGRAM_ALLOWED_CHAT_IDS, or TELEGRAM_ALLOW_ALL=1 for local discovery." >&2
  exit 2
fi
saturn_require_command node >/dev/null

LABEL="com.zachrizzo.saturn-telegram-dispatch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
SERVICE_PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

mkdir -p "$HOME/Library/LaunchAgents" "$AUTOMATIONS_ROOT/runs" "$AUTOMATIONS_ROOT/telegram"

xml() {
  printf '%s' "$1" | saturn_xml_escape
}

ROOT_XML="$(xml "$AUTOMATIONS_ROOT")"
NODE_XML="$(xml "$NODE_BIN")"
PATH_XML="$(xml "$SERVICE_PATH")"
TOKEN_XML="$(xml "$TELEGRAM_BOT_TOKEN")"
BOT_USERNAME_XML="$(xml "${TELEGRAM_BOT_USERNAME:-replace-with-bot-username}")"
ALLOWED_XML="$(xml "${TELEGRAM_ALLOWED_CHAT_IDS:-}")"
ALLOW_ALL_XML="$(xml "${TELEGRAM_ALLOW_ALL:-0}")"
BASE_URL_XML="$(xml "${SATURN_BASE_URL:-http://127.0.0.1:3737}")"
ADHOC_CLI_XML="$(xml "${SATURN_ADHOC_CLI:-claude-bedrock}")"
ADHOC_MODEL_XML="$(xml "${SATURN_ADHOC_MODEL:-claude-sonnet-4-6}")"
AGENT_ID_XML="$(xml "${SATURN_AGENT_ID:-}")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec "$NODE_XML" "$ROOT_XML/bin/telegram-dispatch.mjs"</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AUTOMATIONS_ROOT</key>
    <string>$ROOT_XML</string>
    <key>PATH</key>
    <string>$PATH_XML</string>
    <key>SATURN_BASE_URL</key>
    <string>$BASE_URL_XML</string>
    <key>TELEGRAM_BOT_TOKEN</key>
    <string>$TOKEN_XML</string>
    <key>TELEGRAM_BOT_USERNAME</key>
    <string>$BOT_USERNAME_XML</string>
    <key>TELEGRAM_ALLOWED_CHAT_IDS</key>
    <string>$ALLOWED_XML</string>
    <key>TELEGRAM_ALLOW_ALL</key>
    <string>$ALLOW_ALL_XML</string>
    <key>SATURN_ADHOC_CLI</key>
    <string>$ADHOC_CLI_XML</string>
    <key>SATURN_ADHOC_MODEL</key>
    <string>$ADHOC_MODEL_XML</string>
    <key>SATURN_AGENT_ID</key>
    <string>$AGENT_ID_XML</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$ROOT_XML/runs/telegram-dispatch.log</string>

  <key>StandardErrorPath</key>
  <string>$ROOT_XML/runs/telegram-dispatch.err.log</string>

  <key>WorkingDirectory</key>
  <string>$ROOT_XML</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "Installed and loaded $PLIST"
