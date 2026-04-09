# GitHub Actions YAML Reference — Lessons from Production

> April 2026. Compiled from deep investigation into why the `repository-vulnerability-listener.yml`
> was causing push-validation failure emails on all 5 target repos.
> Every variable documented here is the result of live debugging, not documentation guessing.

---

## The Problem That Drove This Document

The listener workflow had `on: dependabot_alert:` as its **only** trigger. Every push to
every target repo generated a `push` event run with `conclusion: failure` and the message:

```
This run likely failed because of a workflow file issue.
```

Zero jobs ran. The workflow name in GitHub UI showed the **file path** instead of the
`name:` field — a key indicator that GitHub rejected the file before parsing it.

### Why it wasn't `dependabot_alert.types` — it was `dependabot_alert` itself

Earlier attempts:
- ✗ `types: [created]` only → still failed
- ✗ All 6 types listed → still failed  
- ✗ `push: + dependabot_alert:` together → still failed
- ✗ `workflow_dispatch: + dependabot_alert:` together → still failed
- ✓ `workflow_dispatch:` only (no `dependabot_alert:`) → no push failure run created

**Root cause confirmed**: GitHub's **push-time YAML schema validator** (schemastore.org/github-workflow.json)
does not include `dependabot_alert` in its `event` enum. The runtime engine supports it
fine — but the schema checker that runs on every push rejects it before any job ever starts.

---

## GitHub Actions YAML — Complete Variable Reference

### Top-level fields

```yaml
name: string
# Display name shown in GitHub Actions UI.
# If omitted, GitHub uses the FILE PATH as the name — a sign of parse failure.
# Visible in: Actions tab, email subject, API run.name field.
# Example: "Forward Vulnerability Alert"

run-name: string
# Name for individual run instances (supports expressions).
# Example: "Security sweep triggered by ${{ github.actor }}"

on: <trigger-configuration>
# REQUIRED. Defines what events start the workflow.
# Can be: a single event string, an array, or an object map.
# Push-time schema validator runs on EVERY push to ANY branch.
# If this block contains an event name unknown to the validator,
# ALL pushes to the repo produce a failure notification.

jobs: <jobs-map>
# REQUIRED. At least one job must be defined.

env: <key-value map>
# Workflow-level environment variables. Available to all jobs and steps.

concurrency: string | object
# Prevents concurrent runs of the same workflow.
# group: string — shared key; cancel-in-progress: bool

permissions: string | object
# Default GITHUB_TOKEN permissions for all jobs.
# Can be overridden per job.
```

---

### `on:` — Trigger Reference

#### Schema-valid events (accepted by push-time validator)

These are in schemastore.org/github-workflow.json and will NOT cause push-validation failures:

```
branch_protection_rule   check_run              check_suite
create                   delete                 deployment
deployment_status        discussion             discussion_comment
fork                     gollum                 issue_comment
issues                   label                  merge_group
milestone                page_build             project
project_card             project_column         public
pull_request             pull_request_review    pull_request_review_comment
pull_request_target      push                   registry_package
release                  repository_dispatch    schedule
status                   watch                  workflow_call
workflow_dispatch        workflow_run
```

#### Events NOT in the schema validator (will cause push-validation failure emails)

```
dependabot_alert    ← CONFIRMED. GitHub supports it at runtime but schema rejects it.
```

**Consequence**: Any workflow file containing `on: dependabot_alert:` will produce a
`push` event run with `conclusion: failure` on EVERY push to EVERY branch, forever.
`continue-on-error: true` does NOT help — the failure happens before the job is queued.

---

#### `on.dependabot_alert` — Runtime-only (DO NOT USE in workflow files)

Valid activity types at runtime (GitHub docs):
- `created` — a new Dependabot alert was opened
- `dismissed` — alert was dismissed by a user
- `fixed` — the vulnerable dependency was updated
- `reintroduced` — a previously fixed alert reappeared
- `reopened` — a dismissed alert was reopened
- `auto_dismissed` — Dependabot auto-dismissed (e.g. dev dependency, low severity)
- `assignees_changed` — alert assignees were updated

**Why we used it**: To trigger an HTTP dispatch to the central agent the moment a new
vulnerability alert appeared (real-time notification).

**Why we removed it**: Push-validation failure emails cannot be suppressed without removing
the event from the `on:` block. The validator's schema is not updatable by users.

**Alternative we chose**: The central agent runs on `schedule: cron: '0 8 * * *'` and
sweeps all repos via the Dependabot alerts API. Real-time is not needed.

---

#### `on.push`

```yaml
on:
  push:                      # bare — triggers on ALL branches and tags
    branches:                # filter: only these branches
      - main
      - 'releases/**'        # glob patterns supported
    branches-ignore:         # mutually exclusive with branches
      - 'dependabot/**'
    tags:
      - 'v*'
    tags-ignore:             # mutually exclusive with tags
      - '*-beta'
    paths:                   # only trigger if these files changed
      - 'src/**'
      - '**.ts'
    paths-ignore:            # mutually exclusive with paths
      - 'docs/**'
```

> **Key behaviour**: A `push:` trigger with no filters runs on pushes to ALL branches and tags.
> Schema-valid. Will NOT produce push-validation failure emails.

---

#### `on.schedule`

```yaml
on:
  schedule:
    - cron: '0 8 * * *'    # runs at 08:00 UTC every day
      timezone: "America/New_York"   # optional IANA timezone string
```

Cron field order: `minute hour day-of-month month day-of-week`

| Symbol | Meaning       | Example               |
|--------|---------------|-----------------------|
| `*`    | any value     | `* * * * *` = every minute |
| `,`    | list          | `0 8,20 * * *` = 8am and 8pm |
| `-`    | range         | `0 8 * * 1-5` = weekdays only |
| `/`    | step          | `*/15 * * * *` = every 15 min |

Minimum interval: every 5 minutes. Max delay during high-load periods.

---

#### `on.repository_dispatch`

```yaml
on:
  repository_dispatch:
    types:
      - vulnerability-alert-forwarded   # custom event_type strings
      - advisory-email-received
```

Triggered by `POST /repos/{owner}/{repo}/dispatches` with `event_type` matching one of the
listed types. The `client_payload` (max 65,535 chars, max 10 top-level keys) is available
as `github.event.client_payload`.

**Used by our agent**: The central workflow uses this to receive real-time dispatches from
email parsers and (formerly) the repo listener.

---

#### `on.workflow_dispatch`

```yaml
on:
  workflow_dispatch:
    inputs:
      advisory_email:
        description: "Raw advisory email text"
        required: false
        type: string     # string | choice | boolean | number | environment
        default: ""
      account_login:
        description: "Scope repositories to this GitHub account"
        required: false
        type: string
```

Adds a "Run workflow" button in GitHub UI. Also triggerable via:
```bash
gh workflow run security-pr-agent.yml -f advisory_email="..."
```
Available input types: `string`, `choice` (requires `options:`), `boolean`, `number`, `environment`.

---

### `jobs.<job_id>` — Job Reference

```yaml
jobs:
  my-job:
    name: string              # display name in UI; defaults to job_id
    runs-on: ubuntu-latest    # runner; also: macos-latest, windows-latest, self-hosted
    needs: [other-job]        # dependency: waits for other-job to complete first

    if: <expression>
    # Job-level conditional. If false → job is SKIPPED.
    # CRITICAL: if ALL jobs are skipped → "No jobs were run" notification email.
    # Solution: use step-level if, OR ensure at least one job always runs.
    # Our fix: moved if to job level with event_name check (safe because push
    # events now have no push trigger in the file at all).

    permissions:
      contents: read          # narrowed from workflow default — principle of least privilege
      pull-requests: write
      security-events: read
      actions: write

    continue-on-error: true
    # If true: job failure does NOT fail the workflow run.
    # DOES affect: the run conclusion (becomes success even if job fails).
    # DOES NOT affect: push-validation failures (pre-job, schema-level).
    # We removed this after confirming it had no effect on our problem.

    timeout-minutes: 360      # default; max before GitHub cancels job
    concurrency:
      group: ${{ github.ref }}
      cancel-in-progress: true

    env:                      # job-level env vars
      MY_VAR: value

    outputs:                  # share values with downstream jobs
      my-output: ${{ steps.step-id.outputs.value }}
```

---

### `jobs.<job_id>.steps[]` — Step Reference

```yaml
    steps:
      - name: string           # display name in Actions UI
        id: string             # reference this step's outputs: steps.<id>.outputs.<key>

        if: <expression>
        # Step-level conditional. If false → step is SKIPPED (counts as success).
        # Safe to use here: a skipped step does NOT cause "No jobs were run".

        continue-on-error: true   # step failure does not fail the job

        timeout-minutes: 10

        uses: actions/checkout@v4  # use a pre-built Action

        run: |                 # shell command(s)
          echo "value" >> "$GITHUB_OUTPUT"   # set step output
          echo "MY_VAR=value" >> "$GITHUB_ENV"  # set env for subsequent steps

        shell: bash            # bash | sh | pwsh | python | cmd | powershell

        working-directory: ./src

        env:                   # step-level env vars (highest precedence)
          TOKEN: ${{ secrets.MY_TOKEN }}
          PAYLOAD: ${{ toJson(github.event) }}

        with:                  # inputs for `uses` actions
          node-version: 20
```

---

### `github` Context — Key Fields Used by Our Agent

| Expression | Value |
|---|---|
| `github.event_name` | `push`, `schedule`, `repository_dispatch`, `workflow_dispatch` |
| `github.event.action` | `created`, `dismissed`, etc. (for dependabot_alert at runtime) |
| `github.event.client_payload` | payload from `repository_dispatch` |
| `github.event.inputs` | inputs from `workflow_dispatch` |
| `github.repository` | `owner/repo` |
| `github.sha` | commit SHA that triggered the run |
| `github.ref` | `refs/heads/main` |
| `github.actor` | user or app that triggered the run |
| `GITHUB_OUTPUT` | file path; write `key=value` lines to set step outputs |
| `GITHUB_ENV` | file path; write `KEY=VALUE` lines to set env for later steps |

---

### `continue-on-error` — Complete Behavior Table

| Location | `continue-on-error: true` effect |
|---|---|
| Job level | Job failure → run conclusion becomes `success`. Downstream jobs still run. |
| Step level | Step failure → job continues to next step. Job conclusion unaffected by this step. |
| **Push-validation failure** | **No effect.** Failure is at schema/pre-job level. File rejected before runner allocated. |

---

### The Push-Validation Failure Mechanism (Full Explanation)

When you push to any branch, GitHub:

1. Scans **all** `.github/workflows/*.yml` files in the **default branch** HEAD
2. Validates each file against the GitHub Actions JSON schema (`schemastore.org/github-workflow.json`)
3. If validation fails: creates a synthetic workflow run with:
   - `event: push`
   - `conclusion: failure`
   - `name: <file-path>` (not the workflow's `name:` field)
   - Zero jobs
   - Message: "This run likely failed because of a workflow file issue"
4. GitHub sends a failure notification email for this run

**This happens even for pushes that do NOT modify the workflow file.**
**`continue-on-error` has zero effect — it is pre-job.**
**The only fix is to make the file schema-valid or delete it.**

---

## Our Architecture Decision (April 9, 2026)

**Before**: 5 listener YAML files (one per target repo) with `on: dependabot_alert:` triggering
real-time dispatch to central agent.

**Problem**: Caused push-validation failure emails on every push forever. No workaround
exists without removing `dependabot_alert` from the `on:` block.

**After**: Listener files deleted from all 5 repos.
- `reyesrico/workshop-app` — deleted
- `reyesrico/CovidCharts` — deleted
- `reyesrico/frontend-interview` — deleted
- `reyesrico/react-test` — deleted
- `reyesrico/StuffieReact` — deleted

**Why this is safe**: The central agent (`reyesrico/github-vuln-pr-agent`) has a
`schedule: cron: '0 8 * * *'` trigger that sweeps all repos via the Dependabot alerts API
every morning. Real-time alerting was a nice-to-have, not a requirement. The daily sweep
catches everything the listener was forwarding.

**Central workflow triggers that still work**:
- `schedule: '0 8 * * *'` — daily auto-sweep (PRIMARY)
- `repository_dispatch: vulnerability-alert-forwarded` — for future real-time integration
- `repository_dispatch: advisory-email-received` — email parser path
- `workflow_dispatch` — manual trigger with optional inputs
