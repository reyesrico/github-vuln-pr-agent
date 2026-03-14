#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-}"
ENABLE_EMAIL="${2:-}"

if [[ -z "$REPO" ]]; then
  echo "Usage: $0 <owner/repo> [--enable-email]"
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

gh variable set DRY_RUN --repo "$REPO" --body "false" >/dev/null
echo "Set variable: DRY_RUN=false"

gh variable set INSTALL_RETRY_WITH_LEGACY_PEER_DEPS --repo "$REPO" --body "true" >/dev/null
echo "Set variable: INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true"

if [[ "$ENABLE_EMAIL" == "--enable-email" ]]; then
  gh variable set EMAIL_ENABLED --repo "$REPO" --body "true" >/dev/null
  echo "Set variable: EMAIL_ENABLED=true"
else
  echo "EMAIL_ENABLED unchanged. Pass --enable-email to enable email notifications."
fi

echo "Production mode update complete for $REPO"
