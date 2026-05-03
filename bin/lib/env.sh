#!/bin/bash
# Shared Saturn shell environment helpers.
#
# These scripts are often launched from cron or launchd, where HOME/PATH are
# minimal and nvm/npm-installed binaries are not visible. Keep path discovery in
# one place so a cloned repo does not need machine-specific sed patches.

if [[ -n "${SATURN_ENV_SH_LOADED:-}" ]]; then
  return 0
fi
SATURN_ENV_SH_LOADED=1

SATURN_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SATURN_REPO_ROOT="$(cd "$SATURN_LIB_DIR/../.." && pwd)"

saturn_prepend_path() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" ]] || return 0
  local current=":${PATH:-}:"
  current="${current//:$dir:/:}"
  current="${current#:}"
  current="${current%:}"
  PATH="$dir${current:+:$current}"
}

saturn_latest_nvm_bin() {
  local candidate
  candidate="$(ls -td "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | head -n 1 || true)"
  [[ -n "$candidate" ]] && printf '%s\n' "$candidate"
  return 0
}

saturn_setup_env() {
  export AUTOMATIONS_ROOT="${AUTOMATIONS_ROOT:-$SATURN_REPO_ROOT}"
  export HOME="${HOME:-$(eval echo ~)}"

  PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  saturn_prepend_path "/bin"
  saturn_prepend_path "/usr/bin"
  saturn_prepend_path "/usr/local/bin"
  saturn_prepend_path "/opt/homebrew/bin"
  saturn_prepend_path "$SATURN_REPO_ROOT/bin"

  local nvm_bin
  nvm_bin="$(saturn_latest_nvm_bin)"
  [[ -n "$nvm_bin" ]] && saturn_prepend_path "$nvm_bin"
  saturn_prepend_path "$HOME/.local/bin"

  export PATH
}

saturn_xml_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

saturn_env_double_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "$value"
}

saturn_require_command() {
  local missing=0
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "missing required command: $cmd" >&2
      missing=1
    fi
  done
  return "$missing"
}
