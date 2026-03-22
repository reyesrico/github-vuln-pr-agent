# Vulnerability PR Agent - Implementation Plan

## Objective
Automate the flow from open Dependabot alerts (and optional advisory signal targeting) to ready-to-review pull requests with email notification.

## Scope
- Run only when an advisory payload is received (manual dispatch with payload or repository_dispatch event).
- Ingest advisory signal from raw GitHub advisory email text.
- Resolve repository scope automatically (explicit list or account auto-discovery).
- Filter open Dependabot alerts by severity, and optionally by advisory signal.
- For each repository, reuse existing Dependabot PR when possible; otherwise attempt batched dependency patch upgrades in one branch.
- Run repository tests/lint commands.
- Validate generated changes and create one PR per repo.
- Send email summary with PR links and merge command for review-ready items, including suggested action guidance.

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
- Prefers Dependabot PR reuse, then calls Fix -> Test -> Validation fallback sequence.
- Opens PR and dispatches notification.

## Delivery Phases
1. Project bootstrap (TypeScript, lint, tests, docs).
2. Alert ingestion and parsing (repositories + CVE/GHSA/dependency signal).
3. Agent pipeline implementation (Fix -> Test -> Validation -> PR).
4. Email notification implementation.
5. Event-gated execution mode (`PROCESS_ONLY_EMAIL_SIGNAL`).
6. One-PR-per-repository batching mode.
7. Dependabot PR reuse fallback strategy.
8. CI alert-dispatch automation with advisory payload requirement.
9. Operational runbook and rollout docs.

## Definition of Done
- `npm run check` passes.
- Workflow runs only with advisory payload (workflow_dispatch/repository_dispatch).
- Workflow dispatch requires advisory email input.
- Agent sends email only when there are actionable outcomes or newly seen alerts.
- Agent suppresses repeated non-actionable skip-only notification noise.
- Email notification includes PR URL and immediate merge command.
- Templates/documentation contain placeholders only (no personal identifiers).
