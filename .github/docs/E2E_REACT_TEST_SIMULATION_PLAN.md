# End-to-End Plan: Simulated Recommendation Flow (react-test)

## Objective
Validate an end-to-end non-vulnerability workflow by simulating an incoming recommendation email, applying a safe dependency change in `reyesrico/react-test`, creating a PR, sending an email notification with the PR URL, and then closing the PR without merging.

## Proposed Small Library
- Library: `is-odd`
- Why: very small, stable, npm-friendly, minimal installation risk.

## Scope
- Target repository: `reyesrico/react-test`
- Simulation input: raw email text containing `reyesrico/react-test`
- Change: add `is-odd`
- Cleanup: close PR after notification (no merge, no uninstall)

## Preconditions
1. `gh auth login` completed and `gh auth status` succeeds.
2. GitHub token available to the runner (`GITHUB_TOKEN`).
3. Repo access to push branches and open PRs.
4. Email mode defined for verification:
- Option A: SMTP real mailbox.
- Option B: Ethereal test inbox (recommended for safe E2E verification).

## Test Flow
1. Simulate incoming recommendation email:
- Example payload includes text like: `Recommendation: add is-odd to reyesrico/react-test`.
- Parse repository from email payload.
- Assert extracted repository includes `reyesrico/react-test`.

2. Add-library phase:
- Clone `reyesrico/react-test`.
- Create branch `e2e/recommend-add-is-odd-<timestamp>`.
- Run `npm install is-odd --save-exact`.
- Run quality commands (`npm run lint --if-present` and `npm test --if-present`).
- Commit and push branch.
- Create PR titled `chore(e2e): add is-odd (simulated recommendation)`.

3. Notification verification (SMTP):
- Send notification email containing PR URL and summary.
- Verify message delivery proof:
- SMTP mode: successful send response (message id) with sender/recipient `reyesrico@hotmail.com`.
- Email body explicitly states recommendation to add `is-odd` and includes PR link.

4. Close PR phase:
- Close the created add PR without merging.
- Confirm PR state is `closed`.

## Expected Outcomes
1. Repository parser accepts simulated email and resolves `reyesrico/react-test`.
2. One add PR is created successfully for `is-odd`.
3. Notification email is sent with PR URL and recommendation text.
4. PR is closed after notification.
5. Logs include branch names, changed files, test outcomes, PR URL, and email message id.

## Failure Handling
1. If add phase fails, stop and report root cause.
2. If email send fails, mark workflow failed even if PR is created.
3. If PR close fails, report manually closable PR link.

## Rollback
1. If PR is still open due to close failure, close it manually.

## Success Criteria
- End-to-end simulation completes with all checkpoints passing.
- Add PR exists, is referenced in notification email, and is then closed.
- Email send evidence is available and auditable.
