# Vulnerability PR Agent - Implementation Plan

## Objective
Automate the full flow from GitHub Dependabot vulnerability detection to a ready-to-merge pull request, including fix, tests, validation, and email notification.

## Scope
- Read open Dependabot alerts across configured repositories.
- For each actionable alert, attempt a dependency patch upgrade in a branch.
- Run repository tests/lint commands.
- Validate generated changes and create PR.
- Send email summary with PR links and merge command.

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
- Calls Fix -> Test -> Validation sequence.
- Opens PR and dispatches notification.

## Delivery Phases
1. Project bootstrap (TypeScript, lint, tests, docs).
2. Alert ingestion and parsing.
3. Agent pipeline implementation.
4. Email notification implementation.
5. CI workflow and operational runbook.

## Definition of Done
- `npm run check` passes.
- Workflow can run on schedule and manual dispatch.
- Email notification includes PR URL and immediate merge command.
- Configuration supports Outlook/Hotmail SMTP.
