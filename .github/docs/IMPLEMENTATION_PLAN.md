# Vulnerability PR Agent - Implementation Plan

## Objective
Automate the flow from open Dependabot alerts (and optional advisory signal targeting) to ready-to-review pull requests with email notification.

## Scope
- Run only when an advisory payload is received (manual dispatch with payload or repository_dispatch event).
- Ingest advisory signal from raw GitHub advisory email text.
- Resolve repository scope automatically (explicit list or account auto-discovery).
- Filter open Dependabot alerts by severity, and optionally by advisory signal.
- Suppress duplicate unchanged alert sets per repository to avoid repeat churn.
- For each repository, reuse existing Dependabot PR when possible; otherwise attempt batched dependency patch upgrades in one branch.
- Execute install/test commands using per-repository runtime resolution (`nodeVersion` override, then `engines.node`, then default).
- Run repository tests/lint commands.
- Validate generated changes and create one PR per repo.
- Auto-merge low-risk/simple dependency-only PRs; keep breaking/complex remediations as manual-review PRs.
- Send email summary with created/auto-merged/manual/skipped/failed outcomes and suggested action guidance.

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
- Applies duplicate suppression, merge policy (auto-merge vs manual), and dispatches notification.

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
10. Runtime-aware execution, breaking-upgrade classification, and merge-policy hardening.

## Definition of Done
- `npm run check` passes.
- Workflow runs only with advisory payload (workflow_dispatch/repository_dispatch).
- Workflow dispatch requires advisory email input.
- Agent sends email only when there are actionable outcomes or newly seen alerts.
- Agent suppresses repeated non-actionable skip-only notification noise.
- Agent suppresses duplicate unchanged alert sets per repository.
- Email notification clearly distinguishes auto-merged vs manual-review-required outcomes.
- Breaking upgrade scenarios are explicitly classified and surfaced with recommendations.
- Templates/documentation contain placeholders only (no personal identifiers).
