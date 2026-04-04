# Agent Improvement Strategy

> Accumulated learnings from three weeks of production operation (March 2026 – April 2026).
> Every section maps to a recurring failure category, its root cause, and the architectural fix.

---

## 1. Infrastructure Failures (Listener / Workflow Layer)

### 1.1 `dependabot_alert.types: [created]` causes push-time schema errors

**Symptom**: Every push to any target repo triggers a GitHub workflow validation failure
(`This run likely failed because of a workflow file issue`) and sends a failure email.

**Root cause**: GitHub's push-time YAML schema validator does not recognise `types` as a valid
sub-key under `dependabot_alert`. The workflow still runs correctly at runtime; the validator
fires first and rejects it.

**Fix applied**: Remove `types: [created]` from the `on.dependabot_alert` trigger. The
step-level `if: github.event.action == 'created'` conditions handle filtering instead.

**Pattern to remember**: Push-time schema validation is stricter than runtime parsing. Any
non-standard event sub-key will fail validation even if GitHub supports it at runtime.

---

### 1.2 Job-level `if` on listener causes "No jobs were run" emails

**Symptom**: GitHub sends notification emails saying `.github/workflows/repository-vulnerability-listener.yml:
No jobs were run` every time Dependabot dismisses, reopens, or auto-fixes an alert.

**Root cause**: The listener had `if: github.event.action == 'created'` at the **job level**.
When Dependabot fires non-`created` events, the job condition fails before any steps run →
GitHub's notification system sees a workflow with zero jobs executed → sends email.

**Fix applied**: Move `if` condition to the **step level**. Add an explicit no-op step for
non-created events (`echo "Skipping dispatch because event action is '...'"`) so the job always
completes (exit 0, one step) regardless of event type.

**Pattern to remember**: At the job level, `if: false` → "No jobs were run" → email. Always
have at least one unconditional step so the job completes cleanly even when no real work is done.

---

### 1.3 Central workflow never ran on schedule

**Symptom**: Agent only ever ran on manual `workflow_dispatch`. Repos accumulated unprocessed
alerts between manual triggers.

**Root cause**: `PROCESS_ONLY_EMAIL_SIGNAL` was hardcoded `true` in the workflow env block,
causing the orchestrator to bail out immediately on the schedule trigger (no email signal
= no processing). The workflow also had no `schedule` trigger at all initially.

**Fix applied**: Added `schedule: cron: '0 8 * * *'` trigger. Made `PROCESS_ONLY_EMAIL_SIGNAL`
conditional: `true` only when a signal payload or advisory email is present; `false`
for scheduled or empty-dispatch runs.

**Pattern to remember**: Any env var that gates processing must be explicitly set to a
permissive value for schedule-triggered runs. Review all env-gate conditions when adding
a new trigger type.

---

### 1.4 Listener rollout is entirely manual

**Symptom**: New repositories are silently unprotected until someone manually runs
`install-repo-listener.sh`. During the rollout, workshop-app and StuffieReact were missing
for several days.

**Root cause**: No automated mechanism to detect reyesrico/* repos that have Dependabot
enabled but lack the vulnerability listener.

**Architectural gap**: The `install-repo-listener.sh` script is idempotent and already handles
create-or-update. What is missing is a **discovery step** that runs periodically and installs
the listener on any repo that doesn't have it.

**Recommended fix** (not yet implemented):
Add a weekly workflow step (or part of the daily sweep) that:
1. Lists all `reyesrico/*` repos with Dependabot alerts enabled via the API.
2. Checks each for the presence of the listener workflow.
3. Runs `install-repo-listener.sh` on any that are missing it.

---

## 2. Agent Runtime Failures (Fix Agent Layer)

### 2.1 `node -c` flag crashes all installs on repos with `engines.node` set

**Symptom**: `Error: Cannot find module '/tmp/.../npm install dep@version --package-lock-only'`
— every install command fails with `MODULE_NOT_FOUND`. The entire batch fails for the repo.

**Root cause**: `wrapCommandWithNodeRuntime` produced:
```
npx -y node@20 -c 'npm install dep@version --package-lock-only'
```
`node -c` is the **check-syntax** flag. Node.js interprets its argument as a *file path* to
syntax-check, not a shell command to execute.

**Fix applied**: Replaced `node -c` with `--package=node@N -- sh -c`:
```
npx --yes --package=node@20 -- sh -c 'npm install dep@version --package-lock-only'
```
`--package` installs node@N and prepends its `bin/` to PATH; `sh -c` then runs the command
normally.

**Pattern to remember**: Never use `node -c` for execution. `node -e` would execute a
JS expression; for shell commands use `sh -c`.

---

### 2.2 `VULN_AGENT_NOTIFIED_ALERT_KEYS` permanently suppresses retry

**Symptom**: After a run that produced only skipped or failed results, all subsequent runs
also skip the same alerts with `"Alert set already processed; waiting for Dependabot state
refresh"` — forever, even when no PR was ever created.

**Root cause**: The orchestrator wrote alert keys to the notified-keys variable after ANY
result (including skipped/failed). On the next run, `hasNewAlertForRepo = false` → the
entire repo is bypassed without checking whether a real fix was applied.

**Fix applied**: When `hasNewAlertForRepo = false`, check for an **active open PR** (either
agent-created or Dependabot). Skip only if an open PR exists. Otherwise fall through to the
full fix flow as a retry.

**Architectural gap**: The notified-keys variable tracks "was the operator notified?" not
"was the vulnerability fixed?". These are two different concepts that should be separate:
- `VULN_AGENT_NOTIFIED_ALERT_KEYS`: operator was emailed (suppress duplicate emails)
- `VULN_AGENT_FIXED_ALERT_KEYS` (proposed): fix was verified applied (suppress retries)

**Recommended improvement**: After a PR is successfully merged, write the alert keys to a
separate `VULN_AGENT_FIXED_ALERT_KEYS` variable. Use this to distinguish "retry worth
attempting" alerts from "verified fixed" alerts. This stops both the infinite-skip loop
and unnecessary re-processing of genuinely resolved alerts.

---

### 2.3 Nested transitive dependency version not updated by top-level install

**Symptom**: Alert stays open after agent creates and merges a PR. Example: `underscore`
bumped to 1.13.8 at top level, but `jsonpath@1.3.0` depends on `underscore@1.13.6` exactly
→ npm creates a nested `node_modules/jsonpath/node_modules/underscore@1.13.6` copy that
Dependabot still flags.

**Root cause**: `npm install dep@version --package-lock-only` only updates the top-level
resolution. A parent package that pins an exact older version gets its own nested copy.
Dependabot scans the lock file and sees the nested copy.

**Fix applied**: After each top-level install, scan `package-lock.json` for nested copies
of the patched dependency that are still below the patched version. For each such parent,
write a **scoped npm override** (`overrides.parent.dep = "^patchedVersion"`) to `package.json`
and re-run `npm install --package-lock-only`.

**Critical detail**: Use `^patchedVersion` (caret), NOT `>=patchedVersion`. The `>=` range
resolves to the latest overall major (e.g., json5@2.2.3 for `>=1.0.2`) which may be a
breaking API change for the parent package. The caret keeps resolution within the same
major version (json5@1.0.2 for `^1.0.2`), which is safe.

---

### 2.4 No-fix-available alerts cause permanent daily failures

**Symptom**: Every daily sweep produces a "skipped / install" row for `babel-traverse`
(CVE-2023-45133). The package is abandoned (Babel 6, unmaintained). No patched version
will ever exist. The agent retries this every day and emails about it every day.

**Root cause**: `babel-traverse@6.x` has no patch. `npm audit fix --package-lock-only` exits
non-zero with "no fix available for at least one dependency in this chain". The agent
marks the batch skipped and the notified-keys do not prevent retrying (because no PR was
created, see §2.2).

**Current state**: The agent correctly produces a "no safe upstream patch available" message
in the email. The operator guidance is correct. But the retry loop continues indefinitely.

**Recommended improvements**:

1. **Separate unfixable alerts from fixable ones in the batch**: When a batch contains both
   alerts with a patched version AND alerts without one, process the fixable subset fully
   (create a real PR) and report the unfixable ones as "manual action required" separately.
   Currently: if `changedFiles > 0` from the fixable subset, a PR IS created. But the email
   conflates both outcomes in a single row.

2. **Acknowledge-and-suppress for truly unfixable alerts**: When `patchedVersion = null` AND
   `npm audit` confirms "no fix available in chain", write the alert key to
   `VULN_AGENT_NOTIFIED_ALERT_KEYS` AND a new `VULN_AGENT_UNFIXABLE_KEYS` variable. On
   subsequent runs, skip the audit fallback for these keys and add a single-line note to the
   email ("N unfixable alerts suppressed — manual migration required"). Send a reminder email
   at most once per week.

3. **Migration guidance in email**: For known abandoned-package patterns (`babel-traverse@6`
   → migrate to `@babel/traverse@7`, `babel-core@6` → `@babel/core@7`), add a concrete
   migration command in the suggested action column.

---

### 2.5 Batch-level failure hides partial successes

**Symptom**: A repo with 3 alerts (2 fixable, 1 unfixable) produces `status: failed` for
ALL 3 alerts and no PR is created, even though 2 could have been fixed.

**Root cause**: `applyFixBatch` wraps all alert processing in a single try/catch in the
orchestrator. If the fixable-alert install commands succeed but the unfixable-alert audit
step throws, the entire batch is marked failed.

**Current state**: Partially improved — the `changedFiles > 0` check does allow creating a
PR even when audit fails. But a thrown exception in `applyInstallCommandWithFallbacks` (for
any one alert) aborts the batch.

**Recommended improvement**: Process each alert's install command independently within the
batch. Collect per-alert success/failure. Write lock changes from whatever succeeded.
Report each alert's status separately in the email row (currently all alerts in a repo
share one row — consider showing per-alert outcomes in the details column).

---

## 3. Alerting / Email Noise

### 3.1 Duplicate emails on repeated scan cycles

**Symptom**: Operator receives identical-looking emails every day for repos with unresolvable
alerts (babel-traverse, etc.).

**Root cause**: The alert-suppression check (`shouldSendEmail = newAlertDetected ||
hasActionableOutcome`) allows an email for `newAlertDetected = true` on the first encounter.
On subsequent runs, `newAlertDetected = false` (keys were written), so email is suppressed
correctly. But if the keys write fails (PATCH API 404 during initial creation), the keys
are not persisted and every run appears "new".

**Current state**: `writeNotifiedAlertKeys` silently swallows write failures (logs warn but
continues). The result is keys never written → every run triggers email.

**Recommended fix**: Distinguish the "variable does not exist" case (needs POST) from a
real API failure. Currently handled via PATCH-then-CREATE fallback, which should work.
Verify that the variable exists after writing and retry once if the read-back fails.

---

## 4. Recommended Architectural Changes (Priority Order)

### P0 — Already implemented, needs stabilisation

| Change | Status |
|--------|--------|
| Listener: step-level if condition + no-op step | ✅ Done |
| Listener: remove `types:` filter | ✅ Done |
| Orchestrator: retry when no active PR exists | ✅ Done |
| FixAgent: nested parent scoped override | ✅ Done (^ version fix April 4) |
| FixAgent: `wrapCommandWithNodeRuntime` sh -c | ✅ Done |
| FixAgent: nested re-run --legacy-peer-deps fallback | ✅ Done |

### P1 — High value, low complexity

- **Unfixable alert suppression**: Write `VULN_AGENT_UNFIXABLE_KEYS` variable when audit
  confirms no fix is available. Skip these on future runs; summarise in email at most weekly.
- **Override version precision**: The scoped override already uses `^patchedVersion`. Extend
  to also write an entry in a `RESOLUTIONS` (yarn) or `overrides` (npm) comment explaining
  why — so future developers understand the override exists for security, not compatibility.
- **Per-alert install isolation**: Wrap each individual `applyInstallCommandWithFallbacks`
  call in its own try/catch so one failing alert does not abort the entire batch.

### P2 — Medium complexity

- **Fix vs Notify key separation**: Introduce `VULN_AGENT_FIXED_ALERT_KEYS` (written only
  after a PR is actually merged, detected via polling or webhook). Use it to distinguish
  confirmed-fixed from suppressed-notified. This eliminates the "retry loop" class of bugs
  entirely.
- **Automated listener discovery**: Weekly workflow step that lists all repos with Dependabot
  enabled and installs the listener on any that are missing it.
- **Per-alert result rows in email**: Instead of one row per repo with concatenated details,
  show one row per alert so the operator can act on each individually.

### P3 — Longer term

- **Auto-merge on Dependabot PR reuse**: When the agent detects a Dependabot PR and all
  CI checks pass, merge it automatically instead of waiting for operator. The current PR
  reuse path already finds these PRs; it just needs a merge call when auto-merge is safe.
- **Ecosystem expansion**: The agent currently handles npm only. Adding pip/PyPI and
  Maven/Gradle would cover Python and Java repos under the same framework.
- **Drift detection**: After a PR merge, verify after 24 h that Dependabot has dismissed
  the alert. If not, trigger a re-evaluation (the nested copy fix may have been incomplete).

---

## 5. Recurring Failure Patterns — Quick Reference

| Email symptom | Cause | Fix |
|---|---|---|
| "No jobs were run" | Job-level `if` on listener | Move condition to step level |
| Workflow failure on every push | `types:` in `dependabot_alert` trigger | Remove `types` block |
| `MODULE_NOT_FOUND` in install | `node -c` flag used as exec | Use `sh -c` |
| "Alert set already processed" loop | Keys written for failed run | Check for active PR before suppressing |
| Alert persists after PR merged | Nested copy not updated | Scoped override with `^patch` version |
| `>=X.Y.Z` override breaks dependency | Resolves to incompatible major | Use `^X.Y.Z` to stay in same major |
| Daily emails for unfixable alert | No suppression for no-patch alerts | Write unfixable keys, suppress after first email |

---

_Last updated: April 4, 2026_
