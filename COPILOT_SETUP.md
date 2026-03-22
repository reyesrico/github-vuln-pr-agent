# GitHub Copilot Setup Guide — reyesrico/github-vuln-pr-agent

This file is intended as context for **GitHub Copilot in VS Code**.
It describes every configuration value that must be set in the repository so that
`reyesrico@hotmail.com` receives notification emails from the Security PR Agent workflow.

---

## 1. Repository Secrets

Set these under **Settings → Secrets and variables → Actions → Secrets (Repository secrets)**.

| Secret name | Value |
|---|---|
| `SECURITY_AGENT_GITHUB_TOKEN` | A fine-grained PAT with Contents read/write, Pull requests write, Dependabot alerts read on all target repositories |
| `SMTP_USER` | `reyesrico@hotmail.com` |
| `SMTP_PASS` | Hotmail app password (generate at https://account.microsoft.com/security — requires 2FA enabled) |

---

## 2. Repository Variables

Set these under **Settings → Secrets and variables → Actions → Variables (Repository variables)**.

### Core variables

| Variable | Value |
|---|---|
| `ACCOUNT_LOGIN` | `reyesrico` |
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
| `EMAIL_TO` | `reyesrico@hotmail.com` |
| `EMAIL_FROM` | `reyesrico@hotmail.com` |
| `SMTP_HOST` | `smtp-mail.outlook.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` |

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
ACCOUNT_LOGIN=reyesrico

# Email notifications
EMAIL_ENABLED=true
EMAIL_FAIL_OPEN=true
EMAIL_TO=reyesrico@hotmail.com
EMAIL_FROM=reyesrico@hotmail.com
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=reyesrico@hotmail.com
SMTP_PASS=<your-hotmail-app-password>

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
./scripts/rollout-actions.sh reyesrico/github-vuln-pr-agent .env --dispatch
```

To switch from dry-run to live mode:

```bash
./scripts/set-production-mode.sh reyesrico/github-vuln-pr-agent --enable-email
```

---

## 6. Trigger the Workflow Manually

```bash
gh workflow run security-pr-agent.yml --repo reyesrico/github-vuln-pr-agent
```

Event-driven dispatch with an advisory email:

```bash
gh workflow run security-pr-agent.yml \
  --repo reyesrico/github-vuln-pr-agent \
  -f advisory_email="$(cat advisory-email.txt)" \
  -f process_only_email_signal=true
```

---

## 7. Hotmail / Outlook SMTP Notes

- **Host:** `smtp-mail.outlook.com`
- **Port:** `587`
- **Encryption:** STARTTLS (`SMTP_SECURE=false` — the client upgrades the connection after connecting)
- **Authentication:** Use an **app password**, not your regular Microsoft account password
- App passwords require 2-step verification to be enabled on the Microsoft account
- Generate at: https://account.microsoft.com/security → Advanced security options → App passwords

---

## 8. Copilot Instructions

If GitHub Copilot is asked to fix or extend this project, the following context applies:

- Notification email recipient and sender: `reyesrico@hotmail.com`
- SMTP provider: Hotmail/Outlook (`smtp-mail.outlook.com:587`, STARTTLS)
- All email and SMTP values flow from environment variables / GitHub Actions variables
- The secret `SMTP_PASS` must never be hardcoded; it is always injected at runtime
- `SMTP_SECURE=false` is correct for port 587 STARTTLS — do **not** change it to `true` (that is for port 465 SSL)
- Dry-run mode (`DRY_RUN=true`) must remain the default until explicitly switched off
- The rollout script (`scripts/rollout-actions.sh`) automates setting all variables and secrets from a local `.env` file
