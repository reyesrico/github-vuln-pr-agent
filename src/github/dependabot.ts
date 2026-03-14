import type { Octokit } from "@octokit/rest";

import { splitRepoFullName } from "./client.js";
import type { DependabotAlert, PullRequestResult, Severity } from "../types.js";

function normalizeSeverity(input: string): Severity {
  if (input === "critical" || input === "high" || input === "moderate") {
    return input;
  }
  return "low";
}

export async function listOpenDependabotAlerts(
  client: Octokit,
  repoFullName: string,
  severities: Severity[],
  limit: number
): Promise<DependabotAlert[]> {
  const { owner, repo } = splitRepoFullName(repoFullName);

  const alerts = await client.paginate(client.rest.dependabot.listAlertsForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100
  });

  const mapped: DependabotAlert[] = alerts
    .map((alert) => {
      const mappedAlert: DependabotAlert = {
        number: alert.number,
        dependencyName: alert.dependency?.package?.name ?? "unknown",
        dependencyEcosystem: alert.dependency?.package?.ecosystem ?? "unknown",
        manifestPath: alert.dependency?.manifest_path ?? "",
        severity: normalizeSeverity(alert.security_vulnerability?.severity ?? "low"),
        summary: alert.security_advisory?.summary ?? "No summary",
        ghsaId: alert.security_advisory?.ghsa_id ?? "unknown",
        htmlUrl: alert.html_url
      };

      const cveId = alert.security_advisory?.cve_id;
      if (cveId) {
        mappedAlert.cveId = cveId;
      }

      const patchedVersion = alert.security_vulnerability?.first_patched_version?.identifier;
      if (patchedVersion) {
        mappedAlert.patchedVersion = patchedVersion;
      }

      return mappedAlert;
    })
    .filter((alert) => severities.includes(alert.severity))
    .filter((alert) => alert.dependencyEcosystem === "npm")
    .filter((alert) => alert.manifestPath.includes("package-lock.json"))
    .slice(0, limit);

  return mapped;
}

export async function findOpenPullRequestByHead(
  client: Octokit,
  repoFullName: string,
  branchName: string
): Promise<number | undefined> {
  const { owner, repo } = splitRepoFullName(repoFullName);

  const prs = await client.rest.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${owner}:${branchName}`,
    per_page: 1
  });

  return prs.data[0]?.number;
}

export async function createSecurityPullRequest(
  client: Octokit,
  repoFullName: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<PullRequestResult> {
  const { owner, repo } = splitRepoFullName(repoFullName);

  const response = await client.rest.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base
  });

  return {
    repoFullName,
    pullNumber: response.data.number,
    pullUrl: response.data.html_url,
    title: response.data.title
  };
}

export async function getDefaultBranch(
  client: Octokit,
  repoFullName: string
): Promise<string> {
  const { owner, repo } = splitRepoFullName(repoFullName);
  const details = await client.rest.repos.get({ owner, repo });
  return details.data.default_branch;
}
