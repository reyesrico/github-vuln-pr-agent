# GitHub Copilot Setup Guide — owner/github-vuln-pr-agent

This file is intended as context for **GitHub Copilot in VS Code**.
It describes every configuration value that must be set in the repository so that
your review inbox receives notification emails from the Security PR Agent workflow.

---

## 1. Repository Secrets

Set these under **Settings → Secrets and variables → Actions → Secrets (Repository secrets)**.

| Secret name | Value |
|---|---|
| `SECURITY_AGENT_GITHUB_TOKEN` | A fine-grained PAT with Contents read/write, Pull requests write, Dependabot alerts read on all target repositories |
| `SMTP_USER` | `security-agent@example.com` |
| `SMTP_PASS` | Provider app password |

---

## 2. Repository Variables

Set these under **Settings → Secrets and variables → Actions → Variables (Repository variables)**.

### Core variables

| Variable | Value |
|---|---|
| `ACCOUNT_LOGIN` | `your_account` |
| `PROCESS_ONLY_EMAIL_SIGNAL` | `true` |
| `DRY_RUN` | `true` (set to `false` when ready for live PR creation) |
| `VULN_SEVERITIES` | `critical,high,moderate` |
| `BRANCH_PREFIX` | `chore/security` |
| `MAX_ALERTS_PER_REPO` | `3` |
| `REPO_COMMANDS` | `{}` |
| `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS` | `true` |

### Email variables

| Variable | Value |
|---|---|
| `EMAIL_ENABLED` | `true` |
| `EMAIL_FAIL_OPEN` | `true` |
| `EMAIL_TO` | `review-inbox@example.com` |
| `EMAIL_FROM` | `security-agent@example.com` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` |

### Optional scope variables (leave blank unless needed)

| Variable | Value |
|---|---|
| `ALERT_REPOSITORIES` | *(leave empty for auto-discovery)* |
| `RAW_GITHUB_EMAIL` | *(paste advisory email text here for event-driven mode)* |

---

## 3. Local `.env` File

Copy `.env.example` to `.env` and fill in:

```env
# Required
GITHUB_TOKEN=<your-github-token>
ACCOUNT_LOGIN=your_account

# Email notifications
EMAIL_ENABLED=true
EMAIL_FAIL_OPEN=true
EMAIL_TO=review-inbox@example.com
EMAIL_FROM=security-agent@example.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=security-agent@example.com
SMTP_PASS=<your-app-password>

# Optional behavior defaults
DRY_RUN=true
VULN_SEVERITIES=critical,high,moderate
BRANCH_PREFIX=chore/security
MAX_ALERTS_PER_REPO=3
INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true
REPO_COMMANDS={}
PROCESS_ONLY_EMAIL_SIGNAL=true
```

---

## 4. Workflow File Reference

The main workflow is: `.github/workflows/security-pr-agent.yml`

It reads all variables and secrets listed above from the repository context.
No changes to the workflow YAML file are needed — all configuration is injected
via repository variables and secrets.

---

## 5. Automated Rollout Command

After filling `.env`, run the rollout script to push all variables and secrets to GitHub automatically:

```bash
./scripts/rollout-actions.sh owner/repo .env --dispatch
```

To switch from dry-run to live mode:

```bash
./scripts/set-production-mode.sh owner/repo --enable-email
```

---

## 6. Trigger the Workflow Manually

```bash
gh workflow run security-pr-agent.yml \
  --repo owner/repo \
  -f advisory_email="$(cat advisory-email.txt)"
```

Event-driven dispatch with an advisory email payload:

```bash
gh api repos/owner/repo/dispatches \
  -f event_type='advisory-email-received' \
  -f client_payload='{"advisory_email":"<raw advisory body>"}'
```

## 7. Runtime Trigger Policy

- The workflow does not run on a schedule.
- The workflow requires advisory payload input to execute.
- Repeated non-actionable runs are not emailed when no new alerts are detected and no actionable outcomes exist.

---

## 8. SMTP Notes

- Use your provider's SMTP host/port/secure settings.
- Use an app password when your provider requires it.
- Keep SMTP credentials in secrets only; never hardcode.

---

## 9. Copilot Instructions

If GitHub Copilot is asked to fix or extend this project, the following context applies:

- Notification email recipient and sender are environment-driven.
- SMTP provider is environment-driven.
- All email and SMTP values flow from environment variables / GitHub Actions variables
- The secret `SMTP_PASS` must never be hardcoded; it is always injected at runtime
- Dry-run mode (`DRY_RUN=true`) must remain the default until explicitly switched off
- The rollout script (`scripts/rollout-actions.sh`) automates setting all variables and secrets from a local `.env` file
