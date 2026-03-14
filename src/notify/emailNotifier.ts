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

function buildHtmlReport(results: ProcessedAlertResult[]): string {
  const rows = results
    .map((result) => {
      const prLink = result.pullRequest
        ? `<a href="${result.pullRequest.pullUrl}">PR #${result.pullRequest.pullNumber}</a>`
        : "N/A";
      const mergeCommand = result.pullRequest
        ? `gh pr merge ${result.pullRequest.pullUrl} --auto --squash`
        : "N/A";

      return `<tr>
<td>${result.repoFullName}</td>
<td>${result.alert.dependencyName}</td>
<td>${result.alert.cveId ?? result.alert.ghsaId}</td>
<td>${result.status}</td>
<td>${prLink}</td>
<td><code>${mergeCommand}</code></td>
<td>${result.details}</td>
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
<th>Dependency</th>
<th>Advisory</th>
<th>Status</th>
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

  const successful = results.filter((result) => result.status === "created").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;

  await transporter.sendMail({
    to: config.to,
    from: config.from,
    subject: `Vulnerability PR Agent: ${successful} created, ${failed} failed, ${skipped} skipped`,
    html: buildHtmlReport(results)
  });
}
