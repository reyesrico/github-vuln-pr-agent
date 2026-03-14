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
- ALERT_REPOSITORIES
- DRY_RUN
- VULN_SEVERITIES
- BRANCH_PREFIX
- MAX_ALERTS_PER_REPO
- REPO_COMMANDS
- EMAIL_ENABLED
- SMTP_HOST
- SMTP_PORT
- SMTP_SECURE

Conditional variables (only when EMAIL_ENABLED=true):
- EMAIL_TO
- EMAIL_FROM

Recommended starter values:
- ALERT_REPOSITORIES=reyesrico/CovidCharts,reyesrico/workshop-app,reyesrico/react-test
- DRY_RUN=true
- VULN_SEVERITIES=critical,high,moderate
- BRANCH_PREFIX=chore/security
- MAX_ALERTS_PER_REPO=3
- REPO_COMMANDS={}
- EMAIL_ENABLED=true
- EMAIL_TO=reyesrico@hotmail.com
- EMAIL_FROM=reyesrico@hotmail.com
- SMTP_HOST=smtp-mail.outlook.com
- SMTP_PORT=587
- SMTP_SECURE=false

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
- Validate logs show repository processing and no auth/config failures.

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
