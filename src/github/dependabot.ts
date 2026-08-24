import type { Octokit } from "@octokit/rest";

import { splitRepoFullName } from "./client.js";
import type { AlertSignal, DependabotAlert, PullRequestResult, Severity } from "../types.js";
import { logWarn } from "../utils/logger.js";

function normalizeSeverity(input: string): Severity {
  if (input === "critical" || input === "high") {
    return input;
  }
  if (input === "moderate" || input === "medium") {
    return "moderate";
  }
  return "low";
}

function isSupportedNodeManifestPath(manifestPath: string): boolean {
  return (
    manifestPath.includes("package-lock.json") ||
    manifestPath.includes("package.json") ||
    manifestPath.includes("yarn.lock") ||
    manifestPath.includes("pnpm-lock.yaml") ||
    manifestPath.includes("npm-shrinkwrap.json")
  );
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
      // Swallow the error so a single inaccessible repo doesn't abort the whole sweep, but
      // surface it loudly: silently returning [] here is indistinguishable from "no open
      // alerts", which would mask real vulnerabilities (e.g. disabled Dependabot alerts,
      // or a token missing the security_events/read scope needed to list alerts).
      logWarn("Unable to list Dependabot alerts for repository; treating as no alerts found", {
        repoFullName,
        status,
        message: maybeError.message ?? "Unknown error",
        hint:
          "Verify Dependabot alerts are enabled for this repository and that GITHUB_TOKEN has permission to read them."
      });
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
    .filter((alert) => isSupportedNodeManifestPath(alert.manifestPath))
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

export async function mergeSecurityPullRequest(
  client: Octokit,
  repoFullName: string,
  pullNumber: number
): Promise<void> {
  const { owner, repo } = splitRepoFullName(repoFullName);

  await client.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: "squash"
  });
}

export async function findReusableDependabotPullRequest(
  client: Octokit,
  repoFullName: string,
  alerts: DependabotAlert[]
): Promise<PullRequestResult | undefined> {
  const { owner, repo } = splitRepoFullName(repoFullName);
  const dependencies = [...new Set(alerts.map((alert) => alert.dependencyName.toLowerCase()))];

  if (dependencies.length === 0) {
    return undefined;
  }

  const response = await client.rest.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 100
  });

  const candidates = response.data.filter((pr) =>
    pr.head.ref.toLowerCase().startsWith("dependabot/")
  );

  const strictMatch = candidates.find((pr) => {
    const title = pr.title.toLowerCase();
    const headRef = pr.head.ref.toLowerCase();
    return dependencies.every((dependency) => title.includes(dependency) || headRef.includes(dependency));
  });

  const relaxedMatch =
    dependencies.length === 1
      ? candidates.find((pr) => {
          const dependency = dependencies[0] ?? "";
          const title = pr.title.toLowerCase();
          const headRef = pr.head.ref.toLowerCase();
          return title.includes(dependency) || headRef.includes(dependency);
        })
      : undefined;

  const match = strictMatch ?? relaxedMatch;
  if (!match) {
    return undefined;
  }

  return {
    repoFullName,
    pullNumber: match.number,
    pullUrl: match.html_url,
    title: match.title
  };
}

export async function findOpenSecurityAgentPullRequest(
  client: Octokit,
  repoFullName: string
): Promise<PullRequestResult | undefined> {
  const { owner, repo } = splitRepoFullName(repoFullName);

  const response = await client.rest.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 100
  });

  const match = response.data.find((pr) => pr.title.toLowerCase().startsWith("fix(security): apply "));
  if (!match) {
    return undefined;
  }

  return {
    repoFullName,
    pullNumber: match.number,
    pullUrl: match.html_url,
    title: match.title
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
