# GitHub Vulnerability PR Agent

Automates security remediation across repositories by turning GitHub Dependabot alerts into tested pull requests with policy-based outcomes: simple fixes can auto-merge, while complex or breaking remediations stay PR-only for manual review.

## How It Works

When a new Dependabot vulnerability alert is created in any monitored repository:

1. The per-repo listener workflow fires immediately on the `dependabot_alert` event.
2. It forwards a structured signal payload to the central agent via `repository_dispatch`.
3. The central agent processes matching alerts, creates a fix branch, runs lint/tests, and opens a PR.
4. The agent applies merge policy: low-risk dependency-only fixes may auto-merge; risky/breaking fixes are left as manual-review PRs.
5. You receive a summary email with created, auto-merged, skipped, and failed outcomes plus recommended actions.

## What You Receive

- **GitHub emails** (raw): Dependabot still sends its own alert emails directly — these are from GitHub's notification system and are not controlled by this agent.
- **Agent emails** (actionable): Sent to your configured `EMAIL_TO` when there are new alerts or PR outcomes to act on. Contains status by repo (auto-merged, manual review, skipped, failed), PR links, and suggested actions. Suppressed on quiet days with no new actionable outcomes.

On a day with a new alert you may receive **both** — one from GitHub announcing the alert, and one from this agent with the PR already created.

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
- Listener event mode (recommended for production): structured payload forwarded automatically by per-repo listener
- Auto-discovery mode: leave both empty and use `ACCOUNT_LOGIN` to scope all owned repos

5. Validate configuration and quality:

```bash
npm run preflight
npm run check
```

6. Start the agent locally:

```bash
npm run dev
```

## Why The Env File Is Important
- `.env` is the single source of truth for local development and E2E simulation.
- Incorrect values can stop PR creation or prevent notifications.
- Keep `.env` outside version control and treat it as sensitive.

## What it does
- Reads open Dependabot alerts filtered by severity (critical, high, moderate) and ecosystem (npm only).
- Suppresses duplicate processing of unchanged alert sets per repository.
- Reuses an existing open Dependabot PR when one already covers the alert.
- Otherwise creates a fix branch, applies remediation, runs lint/tests, validates changed files, and opens a PR.
- One PR per repository (batched) — never multiple PRs for the same repo in one run.
- Runs install/test commands with per-repo runtime resolution (`REPO_COMMANDS.nodeVersion`, then `engines.node`, then default runtime).
- Auto-merges low-risk/simple dependency-only outcomes after successful validation.
- Keeps difficult/breaking upgrades as PR-only and marks them for manual review.
- Sends a summary email only when there are actionable outcomes or newly seen alerts.

## Multi-agent pipeline
- Fix Agent: applies dependency update in a branch.
- Test Agent: runs lint/test commands.
- Validation Agent: verifies branch readiness.
- Orchestrator Agent: coordinates all steps and notifications.

## Production Trigger Model

| Trigger | When | Signal mode |
|---|---|---|
| `dependabot_alert` listener | Immediately on new alert in target repo | Signal-scoped (one alert) |
| `workflow_dispatch` (manual) | On demand | Signal-scoped when advisory payload is provided |
| `repository_dispatch` `vulnerability-alert-forwarded` | Integration / custom tooling | Signal-scoped |

## Alert Processing Rules
- Severity filter: `critical`, `high`, `moderate`
- Ecosystem filter: npm only
- Manifest filter: `package-lock.json`, `package.json`, `yarn.lock`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`
- One PR per repo per run (batched)
- Duplicate unchanged alert sets are suppressed per repository
- Reuses open Dependabot PRs first; falls back to local fix branch
- Auto-merges low-risk/simple fixes after successful validation
- Classifies force/major compatibility paths as `breaking-upgrade` and keeps them manual
- Email suppressed if all alerts already notified and no new actionable outcomes

### ADVISORY_SIGNAL_PAYLOAD Example

This JSON payload is built and forwarded automatically by the per-repo listener workflow. You do not need to construct it manually in production.

```json
{
	"source": "dependabot_alert",
	"repository": "your_account/repo1",
	"cve_ids": ["CVE-2026-31802"],
	"ghsa_ids": ["GHSA-9HJG-PF89-8W2R"],
	"dependency_names": ["tar"],
	"alert_number": 42,
	"advisory_url": "https://github.com/your_account/repo1/security/dependabot/42"
}
```

## Running In Dev
- In production mode, run with advisory signal payloads only (`PROCESS_ONLY_EMAIL_SIGNAL=true`).
- To simulate a specific alert locally, provide `ADVISORY_SIGNAL_PAYLOAD` and set `PROCESS_ONLY_EMAIL_SIGNAL=true`.

Example local commands:

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
- Install retries automatically fall back to `--legacy-peer-deps` when `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true`.
- Auto-merged outcomes are reported directly in email; manual-review outcomes include PR links and suggested actions.
- Email reports include failure category for faster production triage.
- `breaking-upgrade` failure category highlights force/major-risk remediation paths.
- `EMAIL_FAIL_OPEN=true` keeps production remediation running even if the email provider is temporarily down.
- Repeated non-actionable alerts are suppressed from email — no noise on quiet days.
- Duplicate unchanged alert sets are suppressed per repository to prevent repeat churn.
- Skipped alerts usually mean no patched version exists yet or the repo is already up to date.
- GitHub's own Dependabot emails are separate from agent emails — both may arrive on the same day for the same alert.
- To add a new repo to the monitored set: `./scripts/install-repo-listener.sh owner/new-repo owner/github-vuln-pr-agent .env`
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
