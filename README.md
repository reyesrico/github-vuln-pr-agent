# GitHub Vulnerability PR Agent

Automates security remediation across multiple repositories.

## Prerequisites
- Node.js 20+
- npm
- GitHub CLI (`gh`) installed and authenticated
- Git configured locally
- For real email delivery: Outlook/Hotmail app password (`SMTP_PASS`)

## Project Setup
1. Install dependencies:

```bash
npm install
```

2. Create local runtime env file:

```bash
cp .env.example .env
```

3. Fill `.env` with required values:
- `GITHUB_TOKEN`
- `ALERT_REPOSITORIES`
- Optional SMTP fields when `EMAIL_ENABLED=true`

4. Validate configuration and quality:

```bash
npm run preflight
npm run check
```

5. Start the agent locally:

```bash
npm run dev
```

## Why The Env File Is Important
- `.env` controls runtime behavior (repository scope, dry-run/live mode, severities, retry strategy, email delivery).
- Incorrect values can stop PR creation or prevent notifications.
- Keep `.env` outside version control and treat it as sensitive.

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

## Email configuration (Hotmail/Live)
- SMTP host default: `smtp-mail.outlook.com`
- SMTP port default: `587`
- TLS mode: `SMTP_SECURE=false` (STARTTLS on port 587)
- `EMAIL_TO` default is `reyesrico@hotmail.com`

## GitHub Actions setup
Use [./.github/workflows/security-pr-agent.yml](.github/workflows/security-pr-agent.yml).
Use [./scripts/rollout-actions.sh](scripts/rollout-actions.sh) to configure variables and secrets automatically.

Add repository variables:
- `ALERT_REPOSITORIES`
- `DRY_RUN`
- `VULN_SEVERITIES`
- `BRANCH_PREFIX`
- `MAX_ALERTS_PER_REPO`
- `REPO_COMMANDS`
- `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS`
- `EMAIL_ENABLED`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `EMAIL_TO` (required when `EMAIL_ENABLED=true`)
- `EMAIL_FROM` (required when `EMAIL_ENABLED=true`)

Add repository secrets:
- `SECURITY_AGENT_GITHUB_TOKEN`
- `SMTP_USER` (required when `EMAIL_ENABLED=true`)
- `SMTP_PASS` (required when `EMAIL_ENABLED=true`)

Production settings location:
- GitHub repository -> Settings -> Secrets and variables -> Actions
- Full rollout guide: [./.github/docs/GITHUB_ROLLOUT_CHECKLIST.md](.github/docs/GITHUB_ROLLOUT_CHECKLIST.md)

Automated rollout command:

```bash
./scripts/rollout-actions.sh owner/repo .env --dispatch
```

Production mode command:

```bash
./scripts/set-production-mode.sh owner/repo --enable-email
```

## How To Start In Production
1. Configure variables/secrets from `.env`:

```bash
./scripts/rollout-actions.sh owner/repo .env
```

2. Switch to live mode:

```bash
./scripts/set-production-mode.sh owner/repo --enable-email
```

3. Trigger workflow:

```bash
gh workflow run security-pr-agent.yml --repo owner/repo
```

## Notes
- Start with `DRY_RUN=true` until you validate behavior.
- For repositories with custom command needs, set `REPO_COMMANDS` as JSON.
- Install retries can automatically fall back to `--legacy-peer-deps` when `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true`.
- Merge shortcut is included in the email as a GitHub CLI command.
- Email reports include failure category for faster production triage.
- Use [./.github/docs/GITHUB_ROLLOUT_CHECKLIST.md](.github/docs/GITHUB_ROLLOUT_CHECKLIST.md) for the full GitHub setup and go-live sequence.

## E2E Recommendation Simulation
- Plan: [./.github/docs/E2E_REACT_TEST_SIMULATION_PLAN.md](.github/docs/E2E_REACT_TEST_SIMULATION_PLAN.md)
- Run:

```bash
GITHUB_TOKEN="$(gh auth token)" npm run e2e:recommendation
```

- Optional overrides:
- `E2E_TARGET_REPO` (default `reyesrico/react-test`)
- `E2E_LIBRARY` (default `is-odd`)
- `E2E_LIBRARY_VERSION` (default `3.0.1`)
- `E2E_EMAIL_MODE` (`ethereal`, `smtp`, or `off`; default `ethereal`)
- `E2E_FLOW_MODE` (`add-only-close` or `add-remove-merge`; default `add-only-close`)
