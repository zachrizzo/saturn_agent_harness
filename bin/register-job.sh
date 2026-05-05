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

# cron runs commands through /bin/sh; quote every generated argument with
# POSIX single quotes instead of relying on path escaping.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

validate_id() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "register-job: $label '$value' must match ^[A-Za-z0-9][A-Za-z0-9._-]*$" >&2
    exit 2
  fi
}

validate_cron() {
  local value="$1"
  local label="$2"
  local fields field
  read -r -a fields <<<"$value"
  if [[ "${#fields[@]}" -ne 5 ]]; then
    echo "register-job: unsafe cron expression for $label: $value" >&2
    exit 2
  fi
  for field in "${fields[@]}"; do
    if [[ ! "$field" =~ ^[A-Za-z0-9*,/._-]+$ ]]; then
      echo "register-job: unsafe cron expression for $label: $value" >&2
      exit 2
    fi
  done
}

RUN_JOB_QUOTED="$(shell_quote "$RUN_JOB_BIN")"
LOG_QUOTED="$(shell_quote "$CRON_LOG")"

if [[ -n "$ONLY" ]]; then
  if [[ "$ONLY" == agent-* ]]; then
    validate_id "${ONLY#agent-}" "agent id"
  else
    validate_id "$ONLY" "job name"
  fi
fi

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
  validate_id "$name" "job name"
  validate_cron "$cron" "$name"
  if [[ -n "$ONLY" && "$name" != "$ONLY" ]]; then
    preserve_marker "# saturn:$name"
    continue
  fi
  new_lines+="$cron $RUN_JOB_QUOTED $(shell_quote "$name") >> $LOG_QUOTED 2>&1 # saturn:$name"$'\n'
done < <(jq -r '.jobs[] | "\(.name) \(.cron)"' "$JOBS_FILE")

if [[ -f "$AGENTS_FILE" ]]; then
  while read -r id cron; do
    [[ -z "$id" || "$cron" == "null" || -z "$cron" ]] && continue
    validate_id "$id" "agent id"
    validate_cron "$cron" "agent-$id"
    marker="# saturn:agent-$id"
    if [[ -n "$ONLY" && "$ONLY" != "agent-$id" ]]; then
      preserve_marker "$marker"
      continue
    fi
    new_lines+="$cron $RUN_JOB_QUOTED --agent $(shell_quote "$id") >> $LOG_QUOTED 2>&1 $marker"$'\n'
  done < <(jq -r '.agents[]? | select(.cron != null and .cron != "") | "\(.id) \(.cron)"' "$AGENTS_FILE")
fi

{
  [[ -n "$filtered" ]] && printf '%s\n' "$filtered"
  printf '%s' "$new_lines"
} | crontab -

echo "Registered jobs:"
crontab -l | grep '# saturn:' || echo "(none)"
