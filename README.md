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
- Listener event mode (recommended for production): set `ADVISORY_SIGNAL_PAYLOAD` with structured advisory JSON payload
- Auto-discovery mode: leave both empty and use `ACCOUNT_LOGIN` to scope owned repos

5. Choose processing mode:
- The workflow is alert-driven only. It requires advisory payload input and runs in signal-only mode.

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

## Production Model
1. Workflow runs only when an advisory payload is dispatched.
2. Agent discovers scope from advisory signal and configured account/repository scope.
3. Agent reads matching Dependabot alerts and applies severity filters.
4. Orchestrator reuses existing Dependabot PRs when possible; otherwise falls back to batched local fixes (one PR per repo).
5. Email report is sent only when there are actionable outcomes or newly seen alerts.

## Signal Gate Explained
- Alert processing is enforced in signal-only mode in workflow runtime.
- Advisory payload is required for execution.
- Broad periodic scans are intentionally disabled.

### RAW_GITHUB_EMAIL Examples
Good example (contains dependency, CVE, and repositories):

```text
[your_account] A security advisory on tar affects at least one repository

node-tar Symlink Path Traversal via Drive-Relative Linkpath
High severity
tar
CVE-2026-31802

Affected Repositories
your_account/repo1
package-lock.json
your_account/repo2
package-lock.json
```

Insufficient example (missing advisory signal and repositories):

```text
Security update available.
Please review your dependencies.
```

Why this matters:
- The parser looks for CVE/GHSA IDs, dependency names, and repository names.
- If those are missing and `PROCESS_ONLY_EMAIL_SIGNAL=true`, the run skips processing.

### ADVISORY_SIGNAL_PAYLOAD Example

```json
{
	"repository": "your_account/repo1",
	"cve_ids": ["CVE-2026-31802"],
	"ghsa_ids": ["GHSA-9HJG-PF89-8W2R"],
	"dependency_names": ["tar"]
}
```

Why this matters:
- This payload is emitted by the target-repo vulnerability listener workflow.
- It avoids inbox parsing and triggers the central agent immediately when the alert is created.

## Running In Dev
- Local runs use the same gate behavior as production.
- If both `RAW_GITHUB_EMAIL` and `ADVISORY_SIGNAL_PAYLOAD` are empty, local run will skip processing when signal mode is enabled.
- For local event simulation, use:
	- `PROCESS_ONLY_EMAIL_SIGNAL=true`
	- either `RAW_GITHUB_EMAIL` or `ADVISORY_SIGNAL_PAYLOAD` populated

Example local commands:

```bash
# Targeted local event simulation
PROCESS_ONLY_EMAIL_SIGNAL=true RAW_GITHUB_EMAIL="$(cat advisory-email.txt)" DRY_RUN=true npm run dev
```

```bash
# Targeted listener payload simulation
PROCESS_ONLY_EMAIL_SIGNAL=true ADVISORY_SIGNAL_PAYLOAD='{"repository":"owner/repo","ghsa_ids":["GHSA-xxxx-yyyy-zzzz"],"dependency_names":["tar"]}' DRY_RUN=true npm run dev
```

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
- `RAW_GITHUB_EMAIL` (optional local/debug fallback)
- `ADVISORY_SIGNAL_PAYLOAD` (optional local/debug fallback)
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

2. Switch to live mode:

```bash
./scripts/set-production-mode.sh owner/repo --enable-email
```

3. Trigger workflow with advisory payload:

```bash
gh workflow run security-pr-agent.yml \
	--repo owner/repo \
	-f advisory_email="$(cat advisory-email.txt)"
```

Event-driven dispatch through repository_dispatch (recommended for integrations):

```bash
gh api repos/owner/repo/dispatches \
	-f event_type='advisory-email-received' \
	-f client_payload='{"advisory_email":"<raw advisory body>"}'
```

Listener-based dispatch (recommended for full automation):
- Add [./.github/templates/repository-vulnerability-listener.yml](.github/templates/repository-vulnerability-listener.yml) to each target repository at `.github/workflows/repository-vulnerability-listener.yml`.
- Set target-repo variable `CENTRAL_SECURITY_AGENT_REPO=owner/github-vuln-pr-agent`.
- Set target-repo secret `CENTRAL_SECURITY_AGENT_DISPATCH_TOKEN` with a token that can dispatch to the central repo.

Automate listener rollout to one target repo:

```bash
./scripts/install-repo-listener.sh owner/target-repo owner/github-vuln-pr-agent .env
```

## Notes
- Start with `DRY_RUN=true` until you validate behavior.
- For repositories with custom command needs, set `REPO_COMMANDS` as JSON.
- Install retries can automatically fall back to `--legacy-peer-deps` when `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true`.
- Merge shortcut is included in the email as a GitHub CLI command.
- Email reports include failure category for faster production triage.
- `EMAIL_FAIL_OPEN=true` keeps production remediation running even if email provider is temporarily down.
- Repeated non-actionable alerts are suppressed from email when there are no new alerts and no actionable outcomes.
- Skipped alerts usually mean either no patched version exists yet or there are no effective file changes for current repo state.
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
