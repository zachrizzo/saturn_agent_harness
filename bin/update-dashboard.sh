#!/bin/bash
# Poll for new commits on origin/main and rebuild + restart the dashboard if needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

REPO="$AUTOMATIONS_ROOT"
LABEL="com.zachrizzo.claude-cron-dashboard"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] dashboard-updater: $*"; }

cd "$REPO"

git fetch origin main 2>&1 | while IFS= read -r line; do log "fetch: $line"; done || true

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
launchctl stop "$LABEL" || true
sleep 2
launchctl start "$LABEL"

log "done — updated to $(git -C "$REPO" rev-parse --short HEAD) and restarted"
