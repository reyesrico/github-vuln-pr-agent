# Architecture

## Runtime
- Node.js + TypeScript service.
- Can run locally or through GitHub Actions schedule.

## Inputs
- GitHub token and repository list.
- Optional raw GitHub email text for repository extraction.
- Optional per-repo command overrides.

## Components
- `src/github/dependabot.ts`: Dependabot alert access and PR creation helpers.
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

## Operational Model
- Trigger every hour.
- Create one PR per alert dependency when successful.
- Send one summary email per run.
