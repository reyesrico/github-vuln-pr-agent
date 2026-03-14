import { createGithubClient } from "../github/client.js";
import {
  createSecurityPullRequest,
  findOpenPullRequestByHead,
  getDefaultBranch,
  listOpenDependabotAlerts
} from "../github/dependabot.js";
import { sendEmailNotification } from "../notify/emailNotifier.js";
import type { AppConfig } from "../config.js";
import type { ProcessedAlertResult } from "../types.js";
import { classifyFailure } from "../utils/failureClassification.js";
import { logError, logInfo, logWarn } from "../utils/logger.js";
import { FixAgent } from "./fixAgent.js";
import { TestAgent } from "./testAgent.js";
import { ValidationAgent } from "./validationAgent.js";

function createPullRequestBody(
  alertSummary: string,
  advisory: string,
  dependencyName: string,
  version: string,
  alertUrl: string,
  prUrlPlaceholder: string
): string {
  return [
    "## Automated Security Fix",
    "",
    `- Dependency: ${dependencyName}`,
    `- Upgraded to: ${version}`,
    `- Advisory: ${advisory}`,
    `- Summary: ${alertSummary}`,
    `- Dependabot Alert: ${alertUrl}`,
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

    for (const repoFullName of config.repositories) {
      logInfo("Processing repository", { repoFullName });
      const alerts = await listOpenDependabotAlerts(
        client,
        repoFullName,
        config.severities,
        config.maxAlertsPerRepo
      );

      if (alerts.length === 0) {
        logInfo("No matching alerts", { repoFullName });
        continue;
      }

      const defaultBranch = await getDefaultBranch(client, repoFullName);

      for (const alert of alerts) {
        logInfo("Handling alert", {
          repoFullName,
          dependency: alert.dependencyName,
          advisory: alert.cveId ?? alert.ghsaId
        });

        try {
          const commands = config.repoCommands[repoFullName] ?? {};
          const fixResult = await this.fixAgent.applyFix({
            repoFullName,
            alert,
            branchPrefix: config.branchPrefix,
            githubToken: config.githubToken,
            dryRun: config.dryRun,
            commands,
            strategy: config.fixStrategy
          });

          if (fixResult.skipped) {
            results.push({
              repoFullName,
              alert,
              status: "skipped",
              details: fixResult.reason ?? "Skipped"
            });
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
            results.push({
              repoFullName,
              alert,
              status: "failed",
              details: validation.reasons.join("; "),
              failureCategory: "validation"
            });
            continue;
          }

          if (config.dryRun) {
            results.push({
              repoFullName,
              alert,
              status: "created",
              details: "Dry run mode: PR creation skipped"
            });
            continue;
          }

          const existingPr = await findOpenPullRequestByHead(
            client,
            repoFullName,
            fixResult.branchName
          );

          if (existingPr) {
            const url = `https://github.com/${repoFullName}/pull/${existingPr}`;
            results.push({
              repoFullName,
              alert,
              status: "skipped",
              details: `Existing PR detected: ${url}`
            });
            continue;
          }

          const placeholder = `https://github.com/${repoFullName}/pull/<new-pr-number>`;
          const title = `fix(security): ${alert.dependencyName} ${alert.patchedVersion ?? "patch"}`;
          const body = createPullRequestBody(
            alert.summary,
            alert.cveId ?? alert.ghsaId,
            alert.dependencyName,
            alert.patchedVersion ?? "unknown",
            alert.htmlUrl,
            placeholder
          );

          const pullRequest = await createSecurityPullRequest(
            client,
            repoFullName,
            title,
            body,
            fixResult.branchName,
            defaultBranch
          );

          results.push({
            repoFullName,
            alert,
            status: "created",
            details: `PR created: ${pullRequest.pullUrl}`,
            pullRequest
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          logError("Alert processing failed", { repoFullName, message });
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

    await sendEmailNotification(config.email, results);
    return results;
  }
}
