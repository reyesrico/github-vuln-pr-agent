import type { Octokit } from "@octokit/rest";

import { splitRepoFullName } from "./client.js";
import type { AlertSignal, DependabotAlert, PullRequestResult, Severity } from "../types.js";

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
  limit: number,
  alertSignal?: AlertSignal
): Promise<DependabotAlert[]> {
  const { owner, repo } = splitRepoFullName(repoFullName);

  let alerts;
  try {
    alerts = await client.paginate(client.rest.dependabot.listAlertsForRepo, {
      owner,
      repo,
      state: "open",
      per_page: 100
    });
  } catch (error) {
    const maybeError = error as { status?: number; message?: string };
    const status = maybeError.status ?? 0;
    const message = (maybeError.message ?? "").toLowerCase();

    if (
      status === 403 ||
      status === 404 ||
      message.includes("dependabot alerts are disabled") ||
      message.includes("resource not accessible")
    ) {
      return [];
    }

    throw error;
  }

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
    .filter((alert) => {
      if (!alertSignal) {
        return true;
      }

      const matchesCve =
        alertSignal.cveIds.length > 0 &&
        Boolean(alert.cveId && alertSignal.cveIds.includes(alert.cveId));
      const matchesGhsa =
        alertSignal.ghsaIds.length > 0 && alertSignal.ghsaIds.includes(alert.ghsaId.toUpperCase());
      const matchesDependency =
        alertSignal.dependencyNames.length > 0 &&
        alertSignal.dependencyNames
          .map((name) => name.toLowerCase())
          .includes(alert.dependencyName.toLowerCase());

      return matchesCve || matchesGhsa || matchesDependency;
    })
    .slice(0, limit);

  return mapped;
}

export async function listAccountRepositories(
  client: Octokit,
  ownerLogin?: string
): Promise<string[]> {
  const repos = await client.paginate(client.rest.repos.listForAuthenticatedUser, {
    visibility: "all",
    affiliation: "owner",
    per_page: 100
  });

  return repos
    .filter((repo) => !ownerLogin || repo.owner?.login === ownerLogin)
    .map((repo) => `${repo.owner?.login}/${repo.name}`)
    .filter((fullName): fullName is string => Boolean(fullName && !fullName.startsWith("undefined/")));
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
