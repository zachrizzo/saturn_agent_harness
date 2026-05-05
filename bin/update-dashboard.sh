#!/bin/bash
# Poll for new commits on origin/main and rebuild + restart the dashboard if needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

REPO="$AUTOMATIONS_ROOT"
LABEL="com.zachrizzo.claude-cron-dashboard"
LOCK_DIR="$REPO/runs/dashboard-update.lock"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] dashboard-updater: $*"; }

cd "$REPO"
mkdir -p "$REPO/runs"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another dashboard update is already running"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

git fetch origin main 2>&1 | while IFS= read -r line; do log "fetch: $line"; done

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"

if [[ "$LOCAL" == "$REMOTE" ]]; then
  log "up to date ($LOCAL)"
  exit 0
fi

log "new commits: $LOCAL -> $REMOTE"

git pull --ff-only origin main 2>&1 | while IFS= read -r line; do log "pull: $line"; done

log "installing dependencies..."
cd "$REPO/dashboard"
npm install --prefer-offline 2>&1 | tail -3 | while IFS= read -r line; do log "npm: $line"; done

log "building dashboard..."
npm run build 2>&1 | while IFS= read -r line; do log "build: $line"; done

log "restarting dashboard service..."
launchctl kickstart -k "gui/$(id -u)/$LABEL" || {
  launchctl kill TERM "gui/$(id -u)/$LABEL" || true
  sleep 2
  launchctl kickstart "gui/$(id -u)/$LABEL"
}

log "done — updated to $(git -C "$REPO" rev-parse --short HEAD) and restarted"
