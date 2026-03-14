# End-to-End Plan: Simulated Recommendation Flow (react-test)

## Objective
Validate an end-to-end non-vulnerability workflow by simulating an incoming recommendation email, applying a safe dependency change in `reyesrico/react-test`, creating a PR, sending an email notification, and then reverting the change with a second PR.

## Proposed Small Library
- Library: `is-odd`
- Why: very small, stable, npm-friendly, minimal installation risk.

## Scope
- Target repository: `reyesrico/react-test`
- Simulation input: raw email text containing `reyesrico/react-test`
- Change 1: add `is-odd`
- Change 2: remove `is-odd` after verification

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

3. Add-phase notification verification:
- Send notification email containing PR URL and summary.
- Verify message delivery proof:
- SMTP mode: successful send response (message id).
- Ethereal mode: preview URL available from Nodemailer.

4. Remove-library phase:
- Clone `reyesrico/react-test`.
- Create branch `e2e/recommend-remove-is-odd-<timestamp>`.
- Run `npm uninstall is-odd --save-exact`.
- Run quality commands again.
- Commit and push branch.
- Create PR titled `chore(e2e): remove is-odd (simulated cleanup)`.

5. Remove-phase notification verification:
- Send second notification email for cleanup PR.
- Verify delivery proof as in step 3.

## Expected Outcomes
1. Repository parser accepts simulated email and resolves `reyesrico/react-test`.
2. Two PRs are created successfully:
- Add PR for `is-odd`.
- Remove PR for `is-odd`.
3. Email notification is sent for both phases and evidence is captured.
4. Logs include branch names, changed files, test command outcomes, PR URLs, and message IDs/preview URLs.

## Failure Handling
1. If add phase fails, stop and report root cause.
2. If add succeeds but remove fails, keep remove task open and report recovery steps.
3. If email send fails, mark workflow failed even if PR is created.

## Rollback
1. If both PRs were created, close them manually if desired.
2. If add PR merged accidentally before remove PR, merge remove PR to restore baseline.

## Success Criteria
- End-to-end simulation completes with all checkpoints passing.
- Add and remove PRs exist and are linked in notifications.
- Email send evidence is available and auditable.
