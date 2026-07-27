import path from "node:path";
import { createGithubClient } from "../github/client.js";
import {
  createSecurityPullRequest,
  findOpenSecurityAgentPullRequest,
  findReusableDependabotPullRequest,
  findOpenPullRequestByHead,
  getDefaultBranch,
  listAccountRepositories,
  listOpenDependabotAlerts,
  mergeSecurityPullRequest
} from "../github/dependabot.js";
import { readNotifiedAlertKeys, writeNotifiedAlertKeys } from "../github/notificationState.js";
import { sendEmailNotification } from "../notify/emailNotifier.js";
import type { AppConfig } from "../config.js";
import type { DependabotAlert, FixResult, ProcessedAlertResult, TestResult } from "../types.js";
import { classifyFailure } from "../utils/failureClassification.js";
import { logError, logInfo, logWarn } from "../utils/logger.js";
import { FixAgent, dependencyResolvedInLockFile, resolveInstallWorkingDirectory } from "./fixAgent.js";
import { TestAgent } from "./testAgent.js";
import { ValidationAgent } from "./validationAgent.js";

function buildAlertNotificationKey(result: ProcessedAlertResult): string {
  const advisory = result.alert.cveId ?? result.alert.ghsaId;
  return `${result.repoFullName}|${result.alert.dependencyName}|${advisory}`;
}

function buildAlertKeyFromAlert(repoFullName: string, alert: DependabotAlert): string {
  const advisory = alert.cveId ?? alert.ghsaId;
  return `${repoFullName}|${alert.dependencyName}|${advisory}`;
}

/**
 * Verifies, per alert, that the fixed lock file actually upgraded the vulnerable dependency
 * to at least its patched version. Returns the set of alert numbers that were NOT resolved —
 * e.g. when `npm audit fix` only produced a same-major bump that still sits below the required
 * (breaking, cross-major) patched version. These must be reported as skipped/breaking rather
 * than falsely reported as "created" just because the batch changed other files.
 */
async function findUnresolvedAlerts(
  localPath: string,
  alerts: DependabotAlert[]
): Promise<Set<number>> {
  const unresolved = new Set<number>();

  for (const alert of alerts) {
    if (!alert.patchedVersion) {
      continue;
    }

    const installDir = resolveInstallWorkingDirectory(localPath, alert.manifestPath);
    const lockFilePath = path.join(installDir, "package-lock.json");
    const resolved = await dependencyResolvedInLockFile(
      lockFilePath,
      alert.dependencyName,
      alert.patchedVersion
    );

    if (!resolved) {
      unresolved.add(alert.number);
    }
  }

  return unresolved;
}

function createPullRequestBody(
  alerts: DependabotAlert[],
  prUrlPlaceholder: string
): string {
  const bulletList = alerts
    .map((alert) => {
      const advisory = alert.cveId ?? alert.ghsaId;
      return `- ${alert.dependencyName} -> ${alert.patchedVersion ?? "unknown"} (${advisory})`;
    })
    .join("\n");

  const alertLinks = alerts.map((alert) => `- ${alert.htmlUrl}`).join("\n");

  return [
    "## Automated Security Fixes",
    "",
    `- Alerts in this PR: ${alerts.length}`,
    "",
    "### Updated Dependencies",
    bulletList,
    "",
    "### Dependabot Alerts",
    alertLinks,
    "",
    "## Validation",
    "- Lint command executed",
    "- Test command executed",
    "",
    "## Quick Merge",
    `Run: gh pr merge ${prUrlPlaceholder} --auto --squash`
  ].join("\n");
}

function isSimpleAutoMergeCandidate(fixResult: FixResult, testResult: TestResult): boolean {
  if (!testResult.success) {
    return false;
  }

  if (fixResult.changedFiles.length === 0 || fixResult.changedFiles.length > 3) {
    return false;
  }

  return fixResult.changedFiles.every((file) =>
    ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"].some(
      (allowed) => file.endsWith(allowed)
    )
  );
}

export class Orchestrator {
  private readonly fixAgent = new FixAgent();

  private readonly testAgent = new TestAgent();

  private readonly validationAgent = new ValidationAgent();

  async run(config: AppConfig): Promise<ProcessedAlertResult[]> {
    const client = createGithubClient(config.githubToken);
    const results: ProcessedAlertResult[] = [];
    const emailSignalActive = Boolean(
      config.alertSignal?.cveIds.length ||
        config.alertSignal?.ghsaIds.length ||
        config.alertSignal?.dependencyNames.length
    );

    if (config.processOnlyEmailSignal && !emailSignalActive) {
      logInfo("No new advisory email signal detected; skipping alert processing", {
        processOnlyEmailSignal: config.processOnlyEmailSignal
      });
      return results;
    }

    const repositories =
      config.repositories.length > 0
        ? config.repositories
        : await listAccountRepositories(client, config.accountLogin);

    for (const repoFullName of repositories) {
      logInfo("Processing repository", { repoFullName });
      const alerts = await listOpenDependabotAlerts(
        client,
        repoFullName,
        config.severities,
        config.maxAlertsPerRepo,
        config.alertSignal
      );

      if (alerts.length === 0) {
        logInfo("No matching alerts", { repoFullName });
        continue;
      }

      let notifiedAlertKeysForRepo = new Set<string>();
      try {
        notifiedAlertKeysForRepo = await readNotifiedAlertKeys(client, repoFullName);
      } catch {
        notifiedAlertKeysForRepo = new Set<string>();
      }

      const currentRepoAlertKeys = alerts.map((alert) => buildAlertKeyFromAlert(repoFullName, alert));
      const hasNewAlertForRepo = currentRepoAlertKeys.some((key) => !notifiedAlertKeysForRepo.has(key));

      if (!hasNewAlertForRepo) {
        const existingSecurityPr = await findOpenSecurityAgentPullRequest(client, repoFullName);

        if (existingSecurityPr) {
          for (const alert of alerts) {
            results.push({
              repoFullName,
              alert,
              status: "skipped",
              details: `Existing PR detected: ${existingSecurityPr.pullUrl}`,
              pullRequest: existingSecurityPr
            });
          }
          continue;
        }

        // No active PR found for previously-notified alerts — fall through to retry the fix flow
        logInfo("All current alerts were previously notified but no active PR exists; retrying fix", {
          repoFullName
        });
      }

      for (const alert of alerts) {
        logInfo("Handling alert", {
          repoFullName,
          dependency: alert.dependencyName,
          advisory: alert.cveId ?? alert.ghsaId
        });
      }

      const actionableAlerts = alerts;

      if (!config.dryRun) {
        const reusableDependabotPr = await findReusableDependabotPullRequest(
          client,
          repoFullName,
          actionableAlerts
        );

        if (reusableDependabotPr) {
          for (const alert of actionableAlerts) {
            results.push({
              repoFullName,
              alert,
              status: "created",
              details: `Reused Dependabot PR: ${reusableDependabotPr.pullUrl}`,
              pullRequest: reusableDependabotPr
            });
          }
          continue;
        }
      }

      const defaultBranch = await getDefaultBranch(client, repoFullName);

      try {
        const commands = config.repoCommands[repoFullName] ?? {};
        const fixResult = await this.fixAgent.applyFixBatch({
          repoFullName,
          alerts: actionableAlerts,
          branchPrefix: config.branchPrefix,
          githubToken: config.githubToken,
          dryRun: config.dryRun,
          commands,
          strategy: config.fixStrategy
        });

        if (fixResult.skipped) {
          for (const alert of actionableAlerts) {
            results.push({
              repoFullName,
              alert,
              status: "skipped",
              details: fixResult.reason ?? "Skipped"
            });
          }
          continue;
        }

        const testResult = await this.testAgent.run(
          repoFullName,
          fixResult.branchName,
          fixResult.localPath,
          commands
        );

        const validation = this.validationAgent.validate(fixResult, testResult);
        if (!validation.valid) {
          for (const alert of actionableAlerts) {
            results.push({
              repoFullName,
              alert,
              status: "failed",
              details: validation.reasons.join("; "),
              failureCategory: "validation"
            });
          }
          continue;
        }

        if (config.dryRun) {
          const unresolvedAlerts = await findUnresolvedAlerts(
            fixResult.localPath,
            actionableAlerts
          );
          for (const alert of actionableAlerts) {
            if (unresolvedAlerts.has(alert.number)) {
              results.push({
                repoFullName,
                alert,
                status: "skipped",
                details:
                  `Dependency ${alert.dependencyName} not upgraded to patched version ` +
                  `${alert.patchedVersion ?? "?"} (breaking upgrade required)`
              });
              continue;
            }
            results.push({
              repoFullName,
              alert,
              status: "created",
              details: "Dry run mode: PR creation skipped"
            });
          }
          continue;
        }

        const unresolvedAlerts = await findUnresolvedAlerts(
          fixResult.localPath,
          actionableAlerts
        );

        if (unresolvedAlerts.size === actionableAlerts.length) {
          logWarn("Fix batch changed files but resolved no target alert", {
            repoFullName,
            branch: fixResult.branchName
          });
          for (const alert of actionableAlerts) {
            results.push({
              repoFullName,
              alert,
              status: "skipped",
              details:
                `Dependency ${alert.dependencyName} not upgraded to patched version ` +
                `${alert.patchedVersion ?? "?"} (breaking upgrade required)`
            });
          }
          continue;
        }

        const existingPr = await findOpenPullRequestByHead(
          client,
          repoFullName,
          fixResult.branchName
        );

        if (existingPr) {
          const url = `https://github.com/${repoFullName}/pull/${existingPr}`;
          for (const alert of actionableAlerts) {
            results.push({
              repoFullName,
              alert,
              status: "skipped",
              details: `Existing PR detected: ${url}`
            });
          }
          continue;
        }

        const placeholder = `https://github.com/${repoFullName}/pull/<new-pr-number>`;
        const title = `fix(security): apply ${actionableAlerts.length} dependency updates`;
        const body = createPullRequestBody(actionableAlerts, placeholder);

        const pullRequest = await createSecurityPullRequest(
          client,
          repoFullName,
          title,
          body,
          fixResult.branchName,
          defaultBranch
        );

        let details = `PR created: ${pullRequest.pullUrl}`;

        if (isSimpleAutoMergeCandidate(fixResult, testResult)) {
          try {
            await mergeSecurityPullRequest(client, repoFullName, pullRequest.pullNumber);
            pullRequest.autoMerged = true;
            details = `PR auto-merged (simple dependency-only change): ${pullRequest.pullUrl}`;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown auto-merge error";
            logWarn("Auto-merge skipped after PR creation", {
              repoFullName,
              pullRequest: pullRequest.pullUrl,
              message
            });
            details = `PR created (auto-merge failed): ${pullRequest.pullUrl}`;
          }
        } else {
          details = `PR created (manual review required): ${pullRequest.pullUrl}`;
        }

        for (const alert of actionableAlerts) {
          if (unresolvedAlerts.has(alert.number)) {
            results.push({
              repoFullName,
              alert,
              status: "skipped",
              details:
                `Dependency ${alert.dependencyName} not upgraded to patched version ` +
                `${alert.patchedVersion ?? "?"} (breaking upgrade required); ` +
                `other alerts in this batch fixed in ${pullRequest.pullUrl}`
            });
            continue;
          }
          results.push({
            repoFullName,
            alert,
            status: "created",
            details,
            pullRequest
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logError("Alert processing failed", { repoFullName, message });
        for (const alert of actionableAlerts) {
          results.push({
            repoFullName,
            alert,
            status: "failed",
            details: message,
            failureCategory: classifyFailure(message)
          });
        }
      }
    }

    if (results.length === 0) {
      logWarn("No alerts processed; no email sent");
      return results;
    }

    const currentAlertKeys = new Set(results.map((result) => buildAlertNotificationKey(result)));
    const hasActionableOutcome = results.some(
      (result) => result.status === "created" || result.status === "failed"
    );

    let shouldSendEmail = true;
    const notifiedAlertKeys = new Set<string>();

    for (const repoFullName of repositories) {
      try {
        const keys = await readNotifiedAlertKeys(client, repoFullName);
        for (const key of keys) {
          notifiedAlertKeys.add(key);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown read error";
        logWarn("Unable to read notified alert keys for repository", {
          repoFullName,
          message
        });
      }
    }

    const newAlertDetected = [...currentAlertKeys].some((key) => !notifiedAlertKeys.has(key));
    shouldSendEmail = hasActionableOutcome || newAlertDetected;

    if (!shouldSendEmail) {
      logInfo("Skipping email notification: no new alerts and no actionable outcomes", {
        alertsProcessed: results.length
      });
    }

    if (!shouldSendEmail) {
      return results;
    }

    try {
      await sendEmailNotification(config.email, results);

      const repoToResults = new Map<string, ProcessedAlertResult[]>();
      for (const result of results) {
        const current = repoToResults.get(result.repoFullName) ?? [];
        current.push(result);
        repoToResults.set(result.repoFullName, current);
      }

      for (const [repoFullName, repoResults] of repoToResults.entries()) {
        try {
          const existingKeys = await readNotifiedAlertKeys(client, repoFullName);
          const repoKeys = repoResults.map((result) => buildAlertNotificationKey(result));
          const mergedKeys = new Set([...existingKeys, ...repoKeys]);
          await writeNotifiedAlertKeys(client, repoFullName, mergedKeys);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown write error";
          logWarn("Unable to persist notified alert keys for repository", {
            repoFullName,
            message
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown email error";
      logError("Email notification failed", { message, failOpen: config.email.failOpen });

      if (!config.email.failOpen) {
        throw error;
      }
    }

    return results;
  }
}
