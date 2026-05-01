#!/bin/bash
# Cache-aware AWS SSO refresh for Claude Code Bedrock runs.
#
# Claude Code's awsAuthRefresh hook is invoked for every fresh `claude --print`
# process. Saturn creates one process per turn, so an unconditional
# `aws sso login` forces a browser/device-code flow far more often than an
# interactive Claude Code session. This helper keeps the same recovery behavior
# but only launches SSO login after the cached credentials fail.

set -euo pipefail

PROFILE="${1:-${AWS_PROFILE:-sondermind-development-new}}"
REGION="${2:-${AWS_REGION:-us-east-1}}"

export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"
export AWS_PAGER=""

if aws sts get-caller-identity \
  --profile "$PROFILE" \
  --region "$REGION" \
  --output json \
  --no-cli-pager \
  >/dev/null 2>&1; then
  exit 0
fi

echo "AWS cached SSO credentials are missing or expired for profile '$PROFILE'; starting SSO login." >&2
exec aws sso login --profile "$PROFILE"
