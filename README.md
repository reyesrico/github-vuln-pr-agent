# GitHub Vulnerability PR Agent

Automates security remediation across multiple repositories.

## What it does
- Reads open Dependabot alerts for configured repositories.
- Creates a branch with the dependency bump to the patched version.
- Runs lint and test commands.
- Validates that security-relevant files changed.
- Creates a pull request.
- Sends an email report with PR links and merge commands.

## Multi-agent pipeline
- Fix Agent: applies dependency update in a branch.
- Test Agent: runs lint/test commands.
- Validation Agent: verifies branch readiness.
- Orchestrator Agent: coordinates all steps and notifications.

## Quick start
1. Copy `.env.example` to `.env`.
2. Set `GITHUB_TOKEN` with access to all target repos.
3. Set `ALERT_REPOSITORIES` or `RAW_GITHUB_EMAIL`.
4. Configure Outlook/Hotmail SMTP credentials.
5. Run:

```bash
npm install
npm run check
npm run dev
```

## Email configuration (Hotmail/Live)
- SMTP host default: `smtp-mail.outlook.com`
- SMTP port default: `587`
- TLS mode: `SMTP_SECURE=false` (STARTTLS on port 587)
- `EMAIL_TO` default is `reyesrico@hotmail.com`

## GitHub Actions setup
Use [./.github/workflows/security-pr-agent.yml](.github/workflows/security-pr-agent.yml).

Add repository variables:
- `ALERT_REPOSITORIES`
- `DRY_RUN`
- `VULN_SEVERITIES`
- `BRANCH_PREFIX`
- `MAX_ALERTS_PER_REPO`
- `REPO_COMMANDS`
- `EMAIL_ENABLED`
- `EMAIL_TO`
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`

Add repository secrets:
- `SECURITY_AGENT_GITHUB_TOKEN`
- `SMTP_USER`
- `SMTP_PASS`

## Notes
- Start with `DRY_RUN=true` until you validate behavior.
- For repositories with custom command needs, set `REPO_COMMANDS` as JSON.
- Merge shortcut is included in the email as a GitHub CLI command.
