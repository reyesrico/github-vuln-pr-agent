import nodemailer from "nodemailer";

import type { ProcessedAlertResult } from "../types.js";

interface EmailConfig {
  enabled: boolean;
  to: string;
  from: string;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

interface RepoEmailSummary {
  repoFullName: string;
  fixes: string[];
  status: "created" | "failed" | "skipped";
  failureCategory?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  details: string[];
}

function summarizeDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();

  if (!normalized.toLowerCase().includes("npm audit")) {
    return normalized.length > 420 ? `${normalized.slice(0, 417)}...` : normalized;
  }

  const highlights: string[] = [];

  const vulnerabilitySummary = normalized.match(/\d+ vulnerabilities? \([^)]+\)/i)?.[0];
  if (vulnerabilitySummary) {
    highlights.push(vulnerabilitySummary);
  }

  const noFixAvailable = normalized.match(/No fix available/i)?.[0];
  if (noFixAvailable) {
    highlights.push("No fix available for at least one dependency in this chain");
  }

  const breakingInstall = normalized.match(/Will install ([^,.;]+), which is a breaking change/i);
  if (breakingInstall?.[1]) {
    highlights.push(`Breaking upgrade candidate: ${breakingInstall[1]}`);
  }

  if (normalized.includes("npm audit fix --force")) {
    highlights.push("Only force remediation path available (npm audit fix --force)");
  }

  if (normalized.includes("Command failed: npm audit fix --package-lock-only")) {
    highlights.push("Non-breaking audit fix attempt did not resolve vulnerabilities");
  }

  if (highlights.length > 0) {
    return highlights.join(" | ");
  }

  return normalized.length > 420 ? `${normalized.slice(0, 417)}...` : normalized;
}

function determineSuggestedAction(summary: RepoEmailSummary): string {
  const detailsText = summary.details.join(" ").toLowerCase();

  if (summary.status === "created") {
    if (detailsText.includes("auto-merged")) {
      return "Auto-merged by the agent (low-risk dependency-only change). Verify post-merge checks if desired.";
    }

    if (detailsText.includes("manual review required")) {
      return "Manual review required before merge due to broader change scope.";
    }

    if (detailsText.includes("reused dependabot pr")) {
      return "Review and merge the listed Dependabot PR.";
    }

    if (summary.pullRequestUrl) {
      return "Review and merge the listed PR.";
    }

    return "No action needed.";
  }

  if (summary.status === "skipped") {
    if (
      detailsText.includes("npm audit fix --force") ||
      detailsText.includes("breaking change") ||
      detailsText.includes("will install webpack@")
    ) {
      return "Breaking upgrade required. Recommendation: review impact, run upgrade in a feature branch, validate app/tests, then merge with a planned release window.";
    }

    if (detailsText.includes("no fix available")) {
      return "No safe upstream patch is available. Recommendation: monitor advisory, reduce exposure, and plan dependency migration/replacement.";
    }

    if (detailsText.includes("no patched version provided")) {
      return "Wait for an upstream patched release or manually review/dismiss the alert.";
    }

    if (detailsText.includes("no file changes after dependency updates")) {
      return "Wait for alert state refresh and rerun later; if repeated, verify repo is already patched.";
    }

    if (detailsText.includes("existing pr detected")) {
      return "Review and merge the existing PR.";
    }

    if (detailsText.includes("alert set already processed")) {
      return "No new action required now. Wait for new alerts or alert-state refresh.";
    }

    return "Review details and rerun when repository state changes.";
  }

  if (summary.failureCategory === "breaking-upgrade") {
    return "Breaking upgrade required. Recommendation: create a dedicated upgrade branch, validate with full CI/smoke checks, then merge in a planned release window.";
  }

  if (summary.failureCategory === "install") {
    return "Set a repo-specific install command or use an existing Dependabot PR/manual update.";
  }

  if (summary.failureCategory === "pr") {
    return "Check branch protection/permissions and rerun.";
  }

  if (summary.failureCategory === "validation" || summary.failureCategory === "test") {
    return "Fix failing checks in the repository and rerun.";
  }

  return "Inspect details, apply repo-specific remediation, and rerun.";
}

function summarizeByRepository(results: ProcessedAlertResult[]): RepoEmailSummary[] {
  const grouped = new Map<string, ProcessedAlertResult[]>();

  for (const result of results) {
    const current = grouped.get(result.repoFullName) ?? [];
    current.push(result);
    grouped.set(result.repoFullName, current);
  }

  return [...grouped.entries()].map(([repoFullName, repoResults]) => {
    const hasFailed = repoResults.some((result) => result.status === "failed");
    const hasCreated = repoResults.some((result) => result.status === "created");
    const status: RepoEmailSummary["status"] = hasFailed
      ? "failed"
      : hasCreated
        ? "created"
        : "skipped";

    const pullRequest = repoResults.find((result) => result.pullRequest)?.pullRequest;
    const failureCategory = repoResults.find((result) => result.failureCategory)?.failureCategory;
    const fixes = repoResults.map((result) => {
      const advisory = result.alert.cveId ?? result.alert.ghsaId;
      return `${result.alert.dependencyName} (${advisory})`;
    });

    const details = [...new Set(repoResults.map((result) => summarizeDetail(result.details)))];

    const summary: RepoEmailSummary = {
      repoFullName,
      fixes,
      status,
      details
    };

    if (failureCategory) {
      summary.failureCategory = failureCategory;
    }

    if (pullRequest?.pullUrl) {
      summary.pullRequestUrl = pullRequest.pullUrl;
      summary.pullRequestNumber = pullRequest.pullNumber;
    }

    return summary;
  });
}

function buildHtmlReport(results: ProcessedAlertResult[]): string {
  const summaries = summarizeByRepository(results);

  const rows = summaries
    .map((summary) => {
      const prLink = summary.pullRequestUrl
        ? `<a href="${summary.pullRequestUrl}">PR #${summary.pullRequestNumber}</a>`
        : "N/A";
      const mergeCommand = summary.pullRequestUrl
        ? `gh pr merge ${summary.pullRequestUrl} --auto --squash`
        : "N/A";
      const fixesHtml = summary.fixes.map((fix) => `- ${fix}`).join("<br>");
      const detailsHtml = summary.details.join("<br>");
      const suggestedAction = determineSuggestedAction(summary);

      return `<tr>
<td>${summary.repoFullName}</td>
<td>${fixesHtml}</td>
<td>${summary.status}</td>
    <td>${summary.failureCategory ?? "N/A"}</td>
<td>${prLink}</td>
<td><code>${mergeCommand}</code></td>
<td>${detailsHtml}</td>
    <td>${suggestedAction}</td>
</tr>`;
    })
    .join("\n");

  return `
<h2>GitHub Vulnerability PR Agent Report</h2>
<p>Security automation finished. Review the PR links and merge command for successful items.</p>
<table border="1" cellpadding="8" cellspacing="0">
<thead>
<tr>
<th>Repository</th>
<th>Fixes</th>
<th>Status</th>
<th>Failure Category</th>
<th>Pull Request</th>
<th>Merge Command</th>
<th>Details</th>
<th>Suggested Action</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
`;
}

export async function sendEmailNotification(
  config: EmailConfig,
  results: ProcessedAlertResult[]
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
  });

  const summaries = summarizeByRepository(results);
  const successful = summaries.filter((summary) => summary.status === "created").length;
  const failed = summaries.filter((summary) => summary.status === "failed").length;
  const skipped = summaries.filter((summary) => summary.status === "skipped").length;

  await transporter.sendMail({
    to: config.to,
    from: config.from,
    subject: `Vulnerability PR Agent: ${successful} created, ${failed} failed, ${skipped} skipped`,
    html: buildHtmlReport(results)
  });
}
