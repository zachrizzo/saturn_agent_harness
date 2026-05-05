#!/bin/bash
# Generate and load the Saturn dashboard LaunchAgent for this checkout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

saturn_require_command npm >/dev/null

LABEL="com.zachrizzo.claude-cron-dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NPM_BIN="$(command -v npm)"
NODE_BIN_DIR="$(dirname "$NPM_BIN")"
SERVICE_PATH="$NODE_BIN_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$HOME/Library/LaunchAgents" "$AUTOMATIONS_ROOT/runs"

ROOT_XML="$(printf '%s' "$AUTOMATIONS_ROOT" | saturn_xml_escape)"
PATH_XML="$(printf '%s' "$SERVICE_PATH" | saturn_xml_escape)"
DASHBOARD_COMMAND="cd $(saturn_env_double_quote "$AUTOMATIONS_ROOT/dashboard") && export PATH=$(saturn_env_double_quote "$SERVICE_PATH") && exec $(saturn_env_double_quote "$NPM_BIN") run start"
DASHBOARD_COMMAND_XML="$(printf '%s' "$DASHBOARD_COMMAND" | saturn_xml_escape)"

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
    <string>$DASHBOARD_COMMAND_XML</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AUTOMATIONS_ROOT</key>
    <string>$ROOT_XML</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>$PATH_XML</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$ROOT_XML/runs/dashboard.log</string>

  <key>StandardErrorPath</key>
  <string>$ROOT_XML/runs/dashboard.err.log</string>

  <key>WorkingDirectory</key>
  <string>$ROOT_XML/dashboard</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "Installed and loaded $PLIST"
echo "Dashboard: http://127.0.0.1:3737"
