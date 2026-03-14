#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-}"
ENV_FILE="${2:-.env}"
DISPATCH="${3:-}"

if [[ -z "$REPO" ]]; then
  echo "Usage: $0 <owner/repo> [env-file] [--dispatch]"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI not found. Install with: brew install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${SECURITY_AGENT_GITHUB_TOKEN:-}" && -n "${GITHUB_TOKEN:-}" ]]; then
  SECURITY_AGENT_GITHUB_TOKEN="$GITHUB_TOKEN"
fi

require_env() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" ]]; then
    echo "Missing required env key: $key"
    exit 1
  fi
}

set_var() {
  local key="$1"
  local value="${!key:-}"
  gh variable set "$key" --repo "$REPO" --body "$value" >/dev/null
  echo "Set variable: $key"
}

set_secret() {
  local key="$1"
  local value="${!key:-}"
  gh secret set "$key" --repo "$REPO" --body "$value" >/dev/null
  echo "Set secret: $key"
}

require_env SECURITY_AGENT_GITHUB_TOKEN

require_env ALERT_REPOSITORIES
require_env DRY_RUN
require_env VULN_SEVERITIES
require_env BRANCH_PREFIX
require_env MAX_ALERTS_PER_REPO
require_env REPO_COMMANDS
require_env INSTALL_RETRY_WITH_LEGACY_PEER_DEPS
require_env EMAIL_ENABLED
require_env SMTP_HOST
require_env SMTP_PORT
require_env SMTP_SECURE

set_secret SECURITY_AGENT_GITHUB_TOKEN

set_var ALERT_REPOSITORIES
set_var DRY_RUN
set_var VULN_SEVERITIES
set_var BRANCH_PREFIX
set_var MAX_ALERTS_PER_REPO
set_var REPO_COMMANDS
set_var INSTALL_RETRY_WITH_LEGACY_PEER_DEPS
set_var EMAIL_ENABLED
set_var SMTP_HOST
set_var SMTP_PORT
set_var SMTP_SECURE

email_enabled_lower="$(printf '%s' "${EMAIL_ENABLED}" | tr '[:upper:]' '[:lower:]')"

if [[ "$email_enabled_lower" == "true" ]]; then
  require_env EMAIL_TO
  require_env EMAIL_FROM
  require_env SMTP_USER
  require_env SMTP_PASS

  set_var EMAIL_TO
  set_var EMAIL_FROM
  set_secret SMTP_USER
  set_secret SMTP_PASS
else
  if [[ -n "${EMAIL_TO:-}" ]]; then
    set_var EMAIL_TO
  fi
  if [[ -n "${EMAIL_FROM:-}" ]]; then
    set_var EMAIL_FROM
  fi
fi

echo "Rollout complete for $REPO"

if [[ "$DISPATCH" == "--dispatch" ]]; then
  echo "Triggering workflow dispatch: security-pr-agent.yml"
  gh workflow run security-pr-agent.yml --repo "$REPO"
  echo "Workflow dispatched. View runs in GitHub Actions UI."
fi
