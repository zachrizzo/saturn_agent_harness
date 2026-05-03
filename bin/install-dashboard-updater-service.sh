#!/bin/bash
# Install a launchd agent that polls for new commits on main and auto-updates the dashboard.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

LABEL="com.zachrizzo.saturn-dashboard-updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UPDATE_SCRIPT="$SCRIPT_DIR/update-dashboard.sh"

ROOT_XML="$(printf '%s' "$AUTOMATIONS_ROOT" | saturn_xml_escape)"
SCRIPT_XML="$(printf '%s' "$UPDATE_SCRIPT" | saturn_xml_escape)"

mkdir -p "$HOME/Library/LaunchAgents" "$AUTOMATIONS_ROOT/runs"
chmod +x "$UPDATE_SCRIPT"

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
    <string>$SCRIPT_XML</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AUTOMATIONS_ROOT</key>
    <string>$ROOT_XML</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>StartInterval</key>
  <integer>60</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$ROOT_XML/runs/dashboard-updater.log</string>

  <key>StandardErrorPath</key>
  <string>$ROOT_XML/runs/dashboard-updater.err.log</string>

  <key>WorkingDirectory</key>
  <string>$ROOT_XML</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "Installed and loaded $PLIST"
echo "Polls every 60s — logs at $AUTOMATIONS_ROOT/runs/dashboard-updater.log"
