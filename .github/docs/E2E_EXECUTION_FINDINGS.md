# E2E Execution Findings

## Date
- 2026-03-13 (local)

## Request Covered
1. Validate recommendation-based E2E flow with real SMTP configuration.
2. Create add-library PR from simulated recommendation email input.
3. Send recommendation email with PR link.
4. Close PR after notification (no merge).

## E2E Run Result
- Command mode: `E2E_EMAIL_MODE=smtp`, `E2E_FLOW_MODE=add-only-close`
- Add PR creation: successful
- PR cleanup by close: successful
- Email send: successful after SMTP credential alignment

## What Is Already Working
- Simulated recommendation parsing for target repository from email payload
- Add-library branch creation and PR creation
- Add-only-close behavior
- PR cleanup by closing (no merge, no uninstall)

## Automation Improvements Implemented
- E2E now supports unattended execution from `.env` via `scripts/run-e2e-recommendation.sh`.
- E2E loads `.env` directly (no temporary password files required).
- Added `E2E_AUTO_CLOSE_ON_ERROR=true` so add PRs are auto-closed even when a later step fails.
- Added `.github/workflows/e2e-recommendation.yml` for unattended `workflow_dispatch` runs.

## Production Learnings Captured
- Added `EMAIL_FAIL_OPEN=true` config so production remediation continues even if notification fails.
- Added `INSTALL_RETRY_WITH_LEGACY_PEER_DEPS=true` fallback for npm peer conflict retries.
- Added failure category reporting for easier production triage.
- Enforced alert-driven execution mode (`PROCESS_ONLY_EMAIL_SIGNAL=true`) and removed schedule-based broad scans.

## Generic Rerun Command

```bash
GITHUB_TOKEN="$(gh auth token)" \
E2E_EMAIL_MODE=smtp \
E2E_FLOW_MODE=add-only-close \
E2E_TARGET_REPO=your_account/repo1 \
E2E_LIBRARY=is-odd \
EMAIL_TO=alerts@example.com \
EMAIL_FROM=sender@example.com \
SMTP_HOST=smtp.example.com \
SMTP_PORT=465 \
SMTP_SECURE=true \
SMTP_USER=sender@example.com \
SMTP_PASS="<app-password>" \
npm run e2e:recommendation
```

## Expected Outcome
- SMTP email delivered to configured recipient from configured sender.
- Email content includes recommendation to add `is-odd` and PR link.
- PR is closed automatically at end of flow.
