#!/usr/bin/env bash
set -euo pipefail

TARGET_REPO="${1:-}"
CENTRAL_REPO="${2:-}"
ENV_FILE="${3:-.env}"

if [[ -z "$TARGET_REPO" || -z "$CENTRAL_REPO" ]]; then
  echo "Usage: $0 <target-owner/repo> <central-owner/repo> [env-file]"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI not found. Install with: brew install gh"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found. Install with: brew install jq"
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

if [[ -z "${SECURITY_AGENT_GITHUB_TOKEN:-}" ]]; then
  echo "Missing SECURITY_AGENT_GITHUB_TOKEN in $ENV_FILE"
  exit 1
fi

TEMPLATE_PATH=".github/templates/repository-vulnerability-listener.yml"
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Template not found: $TEMPLATE_PATH"
  exit 1
fi

tmp_file="$(mktemp)"
cp "$TEMPLATE_PATH" "$tmp_file"

encoded_content="$(base64 < "$tmp_file" | tr -d '\n')"
workflow_path=".github/workflows/repository-vulnerability-listener.yml"

sha="$(gh api "repos/$TARGET_REPO/contents/$workflow_path" --jq '.sha' 2>/dev/null || true)"

if [[ -n "$sha" ]]; then
  gh api "repos/$TARGET_REPO/contents/$workflow_path" \
    --method PUT \
    -f message="chore(security): update vulnerability listener workflow" \
    -f content="$encoded_content" \
    -f sha="$sha" >/dev/null
  echo "Updated workflow: $TARGET_REPO/$workflow_path"
else
  gh api "repos/$TARGET_REPO/contents/$workflow_path" \
    --method PUT \
    -f message="chore(security): add vulnerability listener workflow" \
    -f content="$encoded_content" >/dev/null
  echo "Created workflow: $TARGET_REPO/$workflow_path"
fi

gh variable set CENTRAL_SECURITY_AGENT_REPO --repo "$TARGET_REPO" --body "$CENTRAL_REPO" >/dev/null
echo "Set variable: CENTRAL_SECURITY_AGENT_REPO ($TARGET_REPO)"

gh secret set CENTRAL_SECURITY_AGENT_DISPATCH_TOKEN --repo "$TARGET_REPO" --body "$SECURITY_AGENT_GITHUB_TOKEN" >/dev/null
echo "Set secret: CENTRAL_SECURITY_AGENT_DISPATCH_TOKEN ($TARGET_REPO)"

rm -f "$tmp_file"

echo "Listener rollout complete for $TARGET_REPO"