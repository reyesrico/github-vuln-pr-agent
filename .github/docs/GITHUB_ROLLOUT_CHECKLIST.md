# GitHub Rollout Checklist

Use this checklist to configure repository settings and safely move from dry run to live PR creation.

## 1. Add GitHub Secrets

Repository Settings -> Secrets and variables -> Actions -> Secrets

- SECURITY_AGENT_GITHUB_TOKEN
- SMTP_USER (required only when EMAIL_ENABLED=true)
- SMTP_PASS (required only when EMAIL_ENABLED=true)

Token guidance:
- Preferred: Fine-grained PAT with access to all target repositories.
- Required permissions on target repositories: Contents read/write, Pull requests write, Dependabot alerts read.

## 2. Add GitHub Variables

Repository Settings -> Secrets and variables -> Actions -> Variables

Required core variables:
- ACCOUNT_LOGIN
- PROCESS_ONLY_EMAIL_SIGNAL
- DRY_RUN
- VULN_SEVERITIES
- BRANCH_PREFIX
- MAX_ALERTS_PER_REPO
- REPO_COMMANDS
- INSTALL_RETRY_WITH_LEGACY_PEER_DEPS
- EMAIL_ENABLED
- EMAIL_FAIL_OPEN
- SMTP_HOST
- SMTP_PORT
- SMTP_SECURE

Optional scope variables:
- ALERT_REPOSITORIES
- RAW_GITHUB_EMAIL

Conditional variables (only when EMAIL_ENABLED=true):
- EMAIL_TO
- EMAIL_FROM

Recommended starter values:
- ACCOUNT_LOGIN=your_account
- PROCESS_ONLY_EMAIL_SIGNAL=true
- ALERT_REPOSITORIES=
- RAW_GITHUB_EMAIL=
- DRY_RUN=true
- VULN_SEVERITIES=critical,high,moderate
- BRANCH_PREFIX=chore/security
- MAX_ALERTS_PER_REPO=3
- REPO_COMMANDS={}
- INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true
- EMAIL_ENABLED=true
- EMAIL_FAIL_OPEN=true
- EMAIL_TO=review-inbox@example.com
- EMAIL_FROM=security-agent@example.com
- SMTP_HOST=smtp.gmail.com
- SMTP_PORT=465
- SMTP_SECURE=true

## 3. Local Preflight Validation

Run this before first workflow run:

- npm run preflight

Expected behavior:
- Logs Startup configuration preflight.
- Logs missingRequiredEnv as empty when everything is configured.
- Exits with Preflight-only mode enabled.

## 4. First GitHub Actions Run (Dry Run)

- Keep DRY_RUN=true.
- Trigger workflow manually from Actions -> Security PR Agent -> Run workflow.
- Pass `advisory_email` input in workflow dispatch (required).
- Validate logs show only advisory-matching alerts are processed.

## 5. Verify Outputs

- Confirm email report arrives (if enabled).
- Confirm status lines reflect created/skipped/failed accurately.
- Confirm any generated branches follow BRANCH_PREFIX.

## 6. Go Live

- Set DRY_RUN=false.
- Trigger workflow_dispatch once.
- Verify PR creation in at least one repository.

## 7. Post-Go-Live Hardening

- Enable branch protections and required checks in target repositories.
- Optionally configure auto-merge policy for security-fix PRs.
- Keep MAX_ALERTS_PER_REPO conservative to control blast radius.

## 8. Optional Unattended E2E Setup

Add these optional variables for `.github/workflows/e2e-recommendation.yml`:
- E2E_TARGET_REPO
- E2E_LIBRARY
- E2E_LIBRARY_VERSION
- E2E_RAW_EMAIL
- E2E_EMAIL_MODE
- E2E_FLOW_MODE
- E2E_AUTO_CLOSE_ON_ERROR

Reuse SMTP and EMAIL variables/secrets from the main workflow.

## 9. Recommended Production Pattern
1. Keep workflow alert-driven (no schedule trigger).
2. Dispatch with `advisory_email` only when a new alert payload arrives.
3. Review resulting PR links from notification email.
4. Non-actionable repeated skips are suppressed from email when there are no new alerts and no actionable outcomes.
