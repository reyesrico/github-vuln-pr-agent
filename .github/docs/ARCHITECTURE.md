# Architecture

## Runtime
- Node.js + TypeScript service.
- Runs locally or in GitHub Actions (hourly schedule + manual dispatch).

## Inputs
- GitHub token (`GITHUB_TOKEN`).
- Repository scope via one of:
	- `ALERT_REPOSITORIES` explicit list.
	- Auto-discovery (`ACCOUNT_LOGIN` with empty `ALERT_REPOSITORIES`).
	- Advisory email signal (`RAW_GITHUB_EMAIL` or `workflow_dispatch` input `advisory_email`).
- Event gate: `PROCESS_ONLY_EMAIL_SIGNAL`.
- Optional per-repo command overrides (`REPO_COMMANDS`).

## Components
- `src/github/dependabot.ts`: Dependabot alert access and PR creation helpers.
- `src/parsers/githubEmailParser.ts`: advisory-email parsing (repositories, CVE, GHSA, dependency signal).
- `src/agents/fixAgent.ts`: Branch creation and dependency fix.
- `src/agents/testAgent.ts`: Lint/test execution.
- `src/agents/validationAgent.ts`: Final readiness checks.
- `src/notify/emailNotifier.ts`: SMTP summary notification.
- `src/agents/orchestrator.ts`: Main control flow.

## Safety
- Supports `DRY_RUN=true` for non-destructive trial runs.
- Limits alerts processed per repo.
- Skips alerts without available patched version.
- Uses temporary clone directory.
- `PROCESS_ONLY_EMAIL_SIGNAL=true` prevents backlog churn when no fresh advisory signal is present.

## Operational Model
1. Trigger via schedule or manual dispatch.
2. Resolve target repositories from explicit list, advisory email, or account auto-discovery.
3. If event-gated and no advisory signal: skip processing.
4. Fetch open Dependabot alerts and filter by severity + advisory signal.
5. For each matching alert: Fix -> Test -> Validate -> PR.
6. Send summary email with created/skipped/failed status and merge-ready PR links.

## Flow Diagram
```mermaid
flowchart TD
	A[New GitHub Security Advisory Alert Arrives] --> B[Agent Parses Advisory Email Signal]
	B --> C[Agent Selects Matching Repositories and Alerts]
	C --> D[Agent Creates Fix Branch and Applies Dependency Update]
	D --> E[Agent Runs Lint and Tests]
	E --> F{Validation Passed?}
	F -- No --> G[Mark Alert as Failed or Skipped in Report]
	F -- Yes --> H[Agent Creates Pull Request]
	H --> I[PR Status: Ready to Review and Merge]
	I --> J[Agent Builds Summary Report]
	G --> J
	J --> K[Agent Sends Email Notification]
	K --> L[User Receives Email with PR Links]
	L --> M[User Reviews and Merges PR]
```

### Flow Notes
1. With `PROCESS_ONLY_EMAIL_SIGNAL=true`, the flow starts only when a fresh advisory signal is present.
2. "Ready to Review and Merge" means the PR passed fix, test, and validation stages.
3. Email includes created PR links plus skipped/failed details for visibility.

## Sequence Diagram
```mermaid
sequenceDiagram
	autonumber
	participant GH as GitHub Advisory System
	participant WF as GitHub Actions Workflow
	participant AG as Vulnerability PR Agent
	participant RP as Target Repository
	participant EM as SMTP Mail Service
	participant US as User

	GH->>WF: New advisory email/event context
	WF->>AG: Run agent with advisory signal
	AG->>AG: Parse CVE/GHSA/dependency + repository scope
	AG->>RP: Fetch matching Dependabot alerts

	loop For each matching alert
		AG->>RP: Create branch and apply dependency fix
		AG->>RP: Run install/lint/test
		AG->>AG: Validate changed files and checks
		alt Validation passed
			AG->>RP: Create PR (Ready to review)
		else Validation failed
			AG->>AG: Record failed/skipped outcome
		end
	end

	AG->>EM: Send summary email with PR links/status
	EM->>US: Deliver report email
	US->>RP: Review and merge ready PRs
```

## Gate Diagram
```mermaid
flowchart LR
	A[Workflow Triggered] --> B{PROCESS_ONLY_EMAIL_SIGNAL=true?}
	B -- No --> C[Process configured scope]
	B -- Yes --> D{Fresh advisory email signal present?}
	D -- No --> E[Skip run to avoid backlog churn]
	D -- Yes --> F[Filter alerts by CVE/GHSA/dependency]
	F --> C
	C --> G[Fix + Test + Validate]
	G --> H{PR ready?}
	H -- Yes --> I[Include merge-ready PR link in email]
	H -- No --> J[Include failure/skipped details in email]
```

## Workflow Dispatch Automation
`security-pr-agent.yml` supports runtime inputs:
- `advisory_email`
- `account_login`
- `alert_repositories`
- `process_only_email_signal`

Inputs override stored repository variables for that run, enabling one-off processing of a newly received advisory email without editing persistent settings.
