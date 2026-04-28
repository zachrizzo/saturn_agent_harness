#!/bin/bash
# register-job.sh [job-name]
# Reads jobs/jobs.json and syncs all (or one named) job into the user's crontab.
# Each managed line carries a "# saturn:<name>" marker so re-runs replace
# the existing line rather than duplicating.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"
saturn_setup_env

JOBS_FILE="$AUTOMATIONS_ROOT/jobs/jobs.json"
AGENTS_FILE="$AUTOMATIONS_ROOT/agents.json"
RUN_JOB_BIN="$AUTOMATIONS_ROOT/bin/run-job.sh"
CRON_LOG="$AUTOMATIONS_ROOT/runs/cron.log"

if [[ ! -x "$RUN_JOB_BIN" ]]; then
  echo "register-job: $RUN_JOB_BIN is not executable" >&2
  exit 2
fi
mkdir -p "$AUTOMATIONS_ROOT/runs"

ONLY="${1:-}"

# cron strips most env vars; resolve absolute paths and escape spaces with \ — cron accepts this on macOS.
escape_path() {
  printf '%s' "$1" | sed 's| |\\ |g'
}

RUN_JOB_ESCAPED="$(escape_path "$RUN_JOB_BIN")"
LOG_ESCAPED="$(escape_path "$CRON_LOG")"

existing="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$existing" | grep -v '# saturn:' || true)"

new_lines=""

preserve_marker() {
  local marker="$1"
  local preserved
  preserved="$(printf '%s\n' "$existing" | grep "${marker}\$" || true)"
  [[ -n "$preserved" ]] && new_lines+="${preserved}"$'\n'
}

while read -r name cron; do
  [[ -z "$name" ]] && continue
  if [[ -n "$ONLY" && "$name" != "$ONLY" ]]; then
    preserve_marker "# saturn:$name"
    continue
  fi
  new_lines+="$cron $RUN_JOB_ESCAPED $name >> $LOG_ESCAPED 2>&1 # saturn:$name"$'\n'
done < <(jq -r '.jobs[] | "\(.name) \(.cron)"' "$JOBS_FILE")

if [[ -f "$AGENTS_FILE" ]]; then
  while read -r id cron; do
    [[ -z "$id" || "$cron" == "null" || -z "$cron" ]] && continue
    marker="# saturn:agent-$id"
    if [[ -n "$ONLY" && "$ONLY" != "agent-$id" ]]; then
      preserve_marker "$marker"
      continue
    fi
    new_lines+="$cron $RUN_JOB_ESCAPED --agent $id >> $LOG_ESCAPED 2>&1 $marker"$'\n'
  done < <(jq -r '.agents[]? | select(.cron != null and .cron != "") | "\(.id) \(.cron)"' "$AGENTS_FILE")
fi

{
  [[ -n "$filtered" ]] && printf '%s\n' "$filtered"
  printf '%s' "$new_lines"
} | crontab -

echo "Registered jobs:"
crontab -l | grep '# saturn:' || echo "(none)"
