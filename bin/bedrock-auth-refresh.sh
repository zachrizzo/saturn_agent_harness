#!/bin/bash
# Cache-aware AWS SSO check for Claude Code Bedrock runs.
#
# Claude Code's awsAuthRefresh hook is invoked for every fresh `claude --print`
# process. Saturn creates one process per turn, so an unconditional
# `aws sso login` forces a browser/device-code flow far more often than an
# interactive Claude Code session. Saturn runs turns in the background, so this
# helper fails fast when cached credentials are missing instead of blocking the
# chat on an interactive SSO login.

set -euo pipefail

PROFILE="${1:-${AWS_PROFILE:-sondermind-development-new}}"
REGION="${2:-${AWS_REGION:-us-east-1}}"

export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
export AWS_SDK_LOAD_CONFIG="1"
export AWS_PAGER=""

if aws sts get-caller-identity \
  --profile "$PROFILE" \
  --region "$REGION" \
  --output json \
  --no-cli-pager \
  >/dev/null 2>&1; then
  exit 0
fi

if [[ "${SATURN_BEDROCK_AUTH_REFRESH_LOGIN:-0}" == "1" ]]; then
  echo "AWS cached SSO credentials are missing or expired for profile '$PROFILE'; starting SSO login." >&2
  exec aws sso login --profile "$PROFILE"
fi

echo "Bedrock is not authenticated for AWS profile '$PROFILE' in $REGION. Run: AWS_PROFILE=$PROFILE AWS_REGION=$REGION aws sso login --profile $PROFILE." >&2
exit 20
