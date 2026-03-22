import { createGithubClient } from "../github/client.js";
import {
  createSecurityPullRequest,
  findOpenPullRequestByHead,
  getDefaultBranch,
  listAccountRepositories,
  listOpenDependabotAlerts
} from "../github/dependabot.js";
import { sendEmailNotification } from "../notify/emailNotifier.js";
import type { AppConfig } from "../config.js";
import type { DependabotAlert, ProcessedAlertResult } from "../types.js";
import { classifyFailure } from "../utils/failureClassification.js";
import { logError, logInfo, logWarn } from "../utils/logger.js";
import { FixAgent } from "./fixAgent.js";
import { TestAgent } from "./testAgent.js";
import { ValidationAgent } from "./validationAgent.js";

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

      for (const alert of alerts) {
        logInfo("Handling alert", {
          repoFullName,
          dependency: alert.dependencyName,
          advisory: alert.cveId ?? alert.ghsaId
        });
      }

      const skippedAlerts = alerts.filter((alert) => !alert.patchedVersion);
      const actionableAlerts = alerts.filter((alert) => Boolean(alert.patchedVersion));

      for (const alert of skippedAlerts) {
        results.push({
          repoFullName,
          alert,
          status: "skipped",
          details: "No patched version provided by Dependabot alert"
        });
      }

      if (actionableAlerts.length === 0) {
        continue;
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
          for (const alert of actionableAlerts) {
            results.push({
              repoFullName,
              alert,
              status: "created",
              details: "Dry run mode: PR creation skipped"
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

        for (const alert of actionableAlerts) {
          results.push({
            repoFullName,
            alert,
            status: "created",
            details: `PR created: ${pullRequest.pullUrl}`,
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

    try {
      await sendEmailNotification(config.email, results);
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
