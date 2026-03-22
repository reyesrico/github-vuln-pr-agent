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

    const details = [...new Set(repoResults.map((result) => result.details))];

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

      return `<tr>
<td>${summary.repoFullName}</td>
<td>${fixesHtml}</td>
<td>${summary.status}</td>
    <td>${summary.failureCategory ?? "N/A"}</td>
<td>${prLink}</td>
<td><code>${mergeCommand}</code></td>
<td>${detailsHtml}</td>
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
