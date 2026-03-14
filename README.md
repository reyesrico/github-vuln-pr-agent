# GitHub Vulnerability PR Agent

Automates security remediation across repositories by turning GitHub advisory signals into tested, review-ready pull requests.

## Prerequisites
- Node.js 20+
- npm
- GitHub CLI (`gh`) installed and authenticated
- Git configured locally
- SMTP account credentials for outbound notification email (`SMTP_USER` and `SMTP_PASS`)

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
- `ACCOUNT_LOGIN` (recommended for auto-discovery mode)
- SMTP fields when `EMAIL_ENABLED=true`

4. Choose repository selection mode:
- Explicit list mode: set `ALERT_REPOSITORIES=owner/repo1,owner/repo2`
- Event mode (recommended): set `RAW_GITHUB_EMAIL` with a fresh advisory email payload
- Auto-discovery mode: leave both empty and use `ACCOUNT_LOGIN` to scope owned repos

5. Keep backlog noise disabled:
- `PROCESS_ONLY_EMAIL_SIGNAL=true` means the agent only processes alerts when a new advisory signal exists in `RAW_GITHUB_EMAIL`.

6. Validate configuration and quality:

```bash
npm run preflight
npm run check
```

7. Start the agent locally:

```bash
npm run dev
```

## Why The Env File Is Important
- `.env` is the single source of truth for local development and E2E simulation.
- Incorrect values can stop PR creation or prevent notifications.
- Keep `.env` outside version control and treat it as sensitive.

## What it does
- Reads Dependabot alerts and filters them using either explicit repo scope or advisory-email signal.
- Creates a branch with the dependency bump to the patched version.
- Runs lint and test commands.
- Validates that security-relevant files changed.
- Creates a pull request when checks pass.
- Sends an email report with PR links and merge commands only for processed alerts.

## Multi-agent pipeline
- Fix Agent: applies dependency update in a branch.
- Test Agent: runs lint/test commands.
- Validation Agent: verifies branch readiness.
- Orchestrator Agent: coordinates all steps and notifications.

## Event-Driven Production Model
1. A fresh GitHub advisory email arrives.
2. Paste the raw advisory email text into workflow input `advisory_email` (manual dispatch), or set `RAW_GITHUB_EMAIL` variable before run.
3. Agent extracts advisory signal (CVE/GHSA/dependency + repositories).
4. Agent processes only matching alerts for that signal.
5. PRs that pass fix, test, and validation are created as ready-to-review.
6. Email report is sent with repository, alert, status, and PR links.

## Email Configuration
- Set `EMAIL_TO` to the review inbox.
- Set `EMAIL_FROM` to the sender address.
- Set SMTP values (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) for your email provider.

## GitHub Actions setup
Use [./.github/workflows/security-pr-agent.yml](.github/workflows/security-pr-agent.yml).
Use [./scripts/rollout-actions.sh](scripts/rollout-actions.sh) to configure variables and secrets automatically.

Add repository variables:
- `ACCOUNT_LOGIN` (recommended)
- `ALERT_REPOSITORIES` (optional)
- `RAW_GITHUB_EMAIL` (optional)
- `PROCESS_ONLY_EMAIL_SIGNAL`
- `DRY_RUN`
- `VULN_SEVERITIES`
- `BRANCH_PREFIX`
- `MAX_ALERTS_PER_REPO`
- `REPO_COMMANDS`
- `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS`
- `EMAIL_ENABLED`
- `EMAIL_FAIL_OPEN`
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

2. Keep event gate enabled:

```bash
# in GitHub Variables
PROCESS_ONLY_EMAIL_SIGNAL=true
```

3. Switch to live mode:

```bash
./scripts/set-production-mode.sh owner/repo --enable-email
```

4. Trigger workflow:

```bash
gh workflow run security-pr-agent.yml --repo owner/repo
```

Manual event-driven dispatch with advisory text:

```bash
gh workflow run security-pr-agent.yml \
	--repo owner/repo \
	-f advisory_email="$(cat advisory-email.txt)" \
	-f process_only_email_signal=true
```

## Notes
- Start with `DRY_RUN=true` until you validate behavior.
- For repositories with custom command needs, set `REPO_COMMANDS` as JSON.
- Install retries can automatically fall back to `--legacy-peer-deps` when `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true`.
- Merge shortcut is included in the email as a GitHub CLI command.
- Email reports include failure category for faster production triage.
- `EMAIL_FAIL_OPEN=true` keeps production remediation running even if email provider is temporarily down.
- `PROCESS_ONLY_EMAIL_SIGNAL=true` prevents processing old pending alerts when no new advisory signal is present.
- Use [./.github/docs/GITHUB_ROLLOUT_CHECKLIST.md](.github/docs/GITHUB_ROLLOUT_CHECKLIST.md) for the full GitHub setup and go-live sequence.

## E2E Recommendation Simulation
- Plan: [./.github/docs/E2E_REACT_TEST_SIMULATION_PLAN.md](.github/docs/E2E_REACT_TEST_SIMULATION_PLAN.md)
- Run:

```bash
GITHUB_TOKEN="$(gh auth token)" npm run e2e:recommendation
```

Unattended local run:

```bash
./scripts/run-e2e-recommendation.sh
```

Unattended GitHub Actions run:
- Workflow: [./.github/workflows/e2e-recommendation.yml](.github/workflows/e2e-recommendation.yml)
- Trigger with `workflow_dispatch` after setting `E2E_*` variables and shared `EMAIL_*` / `SMTP_*` runtime values.

- Optional overrides:
- `E2E_TARGET_REPO` (default `your_account/repo1`)
- `E2E_LIBRARY` (default `is-odd`)
- `E2E_LIBRARY_VERSION` (default `3.0.1`)
- `E2E_EMAIL_MODE` (`ethereal`, `smtp`, or `off`; default `ethereal`)
- `E2E_FLOW_MODE` (`add-only-close` or `add-remove-merge`; default `add-only-close`)
- `E2E_AUTO_CLOSE_ON_ERROR` (`true`/`false`; default `true`)
- `EMAIL_TO`, `EMAIL_FROM`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`
