# Vulnerability PR Agent - Implementation Plan

## Objective
Automate the flow from open Dependabot alerts (and optional advisory signal targeting) to ready-to-review pull requests with email notification.

## Scope
- Run fully automatically on schedule without manual advisory input.
- Optionally ingest advisory signal from raw GitHub advisory email text for targeted runs.
- Resolve repository scope automatically (explicit list or account auto-discovery).
- Filter open Dependabot alerts by severity, and optionally by advisory signal.
- For each actionable alert, attempt a dependency patch upgrade in a branch.
- Run repository tests/lint commands.
- Validate generated changes and create PR.
- Send email summary with PR links and merge command for review-ready items.

## Multi-Agent Design
1. Fix Agent
- Clones the target repository.
- Applies a safe dependency bump to the first patched version.
- Commits and pushes the branch.

2. Test Agent
- Executes repository lint/test commands.
- Returns pass/fail and captured output.

3. Validation Agent
- Ensures security-relevant files changed.
- Verifies command results and branch readiness.

4. Orchestrator Agent
- Fetches alerts.
- Applies advisory signal filtering and processing gate.
- Calls Fix -> Test -> Validation sequence.
- Opens PR and dispatches notification.

## Delivery Phases
1. Project bootstrap (TypeScript, lint, tests, docs).
2. Alert ingestion and parsing (repositories + CVE/GHSA/dependency signal).
3. Agent pipeline implementation (Fix -> Test -> Validation -> PR).
4. Email notification implementation.
5. Event-gated execution mode (`PROCESS_ONLY_EMAIL_SIGNAL`).
6. Fully automated execution mode (`PROCESS_ONLY_EMAIL_SIGNAL=false`).
7. CI workflow dispatch automation with advisory input overrides.
8. Operational runbook and rollout docs.

## Definition of Done
- `npm run check` passes.
- Workflow can run on schedule and manual dispatch.
- Workflow dispatch accepts advisory email input for one-off event runs.
- Agent runs fully automated on schedule when `PROCESS_ONLY_EMAIL_SIGNAL=false`.
- Agent skips backlog processing when no new advisory signal is present and gate is enabled.
- Email notification includes PR URL and immediate merge command.
- Templates/documentation contain placeholders only (no personal identifiers).
