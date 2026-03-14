import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import nodemailer from "nodemailer";
import { z } from "zod";

import { createGithubClient, splitRepoFullName } from "../github/client.js";
import { createSecurityPullRequest, getDefaultBranch } from "../github/dependabot.js";
import { extractRepositoriesFromGithubEmail } from "../parsers/githubEmailParser.js";
import { runCommand } from "../utils/exec.js";
import { logError, logInfo } from "../utils/logger.js";

const schema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  E2E_TARGET_REPO: z.string().default("reyesrico/react-test"),
  E2E_LIBRARY: z.string().default("is-odd"),
  E2E_LIBRARY_VERSION: z.string().default("3.0.1"),
  E2E_RAW_EMAIL: z
    .string()
    .default("Subject: recommendation\nPlease add is-odd to reyesrico/react-test"),
  E2E_EMAIL_MODE: z.enum(["ethereal", "smtp", "off"]).default("ethereal"),
  EMAIL_TO: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_SECURE: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional()
});

type Phase = "add" | "remove";

interface PhaseResult {
  phase: Phase;
  branchName: string;
  changedFiles: string[];
  pullNumber: number;
  pullUrl: string;
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function createBranchName(phase: Phase, library: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `e2e/recommend-${phase}-${library}-${stamp}`;
}

function createPrBody(phase: Phase, library: string, simulatedEmail: string): string {
  return [
    "## E2E Recommendation Simulation",
    "",
    `- Phase: ${phase}`,
    `- Library: ${library}`,
    "- Source: simulated incoming recommendation email",
    "",
    "### Simulated Email Input",
    "```text",
    simulatedEmail,
    "```"
  ].join("\n");
}

async function ensureSuccess(command: string, cwd: string, stepName: string): Promise<string> {
  const result = await runCommand(command, cwd);
  if (!result.success) {
    throw new Error(`${stepName} failed: ${result.output}`);
  }
  return result.output;
}

async function runQualityChecks(repoDir: string): Promise<void> {
  const packageJsonPath = path.join(repoDir, "package.json");
  let scripts: Record<string, string> = {};

  try {
    const content = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    scripts = parsed.scripts ?? {};
  } catch {
    scripts = {};
  }

  if (typeof scripts.lint === "string" && scripts.lint.trim()) {
    await ensureSuccess("npm run lint", repoDir, "Lint");
  }

  const testScript = scripts.test?.trim();
  if (!testScript) {
    return;
  }

  const isPlaceholderTest = /no test specified|exit 1/i.test(testScript);
  if (isPlaceholderTest) {
    logInfo("Skipping placeholder test script", { testScript });
    return;
  }

  await ensureSuccess("npm run test", repoDir, "Test");
}

async function runPhase(
  token: string,
  repoFullName: string,
  defaultBranch: string,
  library: string,
  version: string,
  simulatedEmail: string,
  phase: Phase
): Promise<PhaseResult> {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "vuln-pr-agent-e2e-"));
  const encodedToken = encodeURIComponent(token);
  const repoDir = path.join(tempBase, repoFullName.replace("/", "__"));
  const cloneUrl = `https://x-access-token:${encodedToken}@github.com/${repoFullName}.git`;

  const branchName = createBranchName(phase, library);

  try {
    await ensureSuccess(`git clone --depth 1 ${cloneUrl} ${repoDir}`, tempBase, "Clone");
    await ensureSuccess(`git checkout -b ${branchName}`, repoDir, "Branch create");

    if (phase === "add") {
      await ensureSuccess(
        `npm install ${library}@${version} --save-exact`,
        repoDir,
        "Install library"
      );
    } else {
      await ensureSuccess(`npm uninstall ${library} --save-exact`, repoDir, "Uninstall library");
    }

    await runQualityChecks(repoDir);

    const statusOutput = await ensureSuccess("git status --porcelain", repoDir, "Git status");
    const changedFiles = parseChangedFiles(statusOutput);
    if (changedFiles.length === 0) {
      throw new Error(`No file changes detected for ${phase} phase`);
    }

    const commitMessage =
      phase === "add"
        ? `chore(e2e): add ${library} (simulated recommendation)`
        : `chore(e2e): remove ${library} (simulated cleanup)`;

    await ensureSuccess("git add -A", repoDir, "Git add");
    await ensureSuccess(
      `git -c user.name="Security Agent" -c user.email="security-agent@users.noreply.github.com" commit -m "${commitMessage}"`,
      repoDir,
      "Git commit"
    );
    await ensureSuccess(`git push origin ${branchName}`, repoDir, "Git push");

    const client = createGithubClient(token);
    const title =
      phase === "add"
        ? `chore(e2e): add ${library} (simulated recommendation)`
        : `chore(e2e): remove ${library} (simulated cleanup)`;
    const pullRequest = await createSecurityPullRequest(
      client,
      repoFullName,
      title,
      createPrBody(phase, library, simulatedEmail),
      branchName,
      defaultBranch
    );

    return {
      phase,
      branchName,
      changedFiles,
      pullNumber: pullRequest.pullNumber,
      pullUrl: pullRequest.pullUrl
    };
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
}

async function mergePullRequest(
  token: string,
  repoFullName: string,
  pullNumber: number,
  phase: Phase
): Promise<void> {
  const client = createGithubClient(token);
  const { owner, repo } = splitRepoFullName(repoFullName);

  const response = await client.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: "squash"
  });

  if (!response.data.merged) {
    throw new Error(`Unable to merge ${phase} phase PR #${pullNumber}`);
  }

  logInfo("PR merged", {
    phase,
    pullNumber,
    sha: response.data.sha,
    message: response.data.message
  });
}

async function sendVerificationEmail(
  mode: "ethereal" | "smtp" | "off",
  phaseResult: PhaseResult,
  env: z.infer<typeof schema>
): Promise<void> {
  if (mode === "off") {
    logInfo("E2E notification email skipped (E2E_EMAIL_MODE=off)");
    return;
  }

  const html = `
<h2>E2E Recommendation Flow Update</h2>
<p>Phase completed: <strong>${phaseResult.phase}</strong></p>
<ul>
<li>PR: <a href="${phaseResult.pullUrl}">${phaseResult.pullUrl}</a></li>
<li>Branch: ${phaseResult.branchName}</li>
<li>Changed files: ${phaseResult.changedFiles.join(", ")}</li>
</ul>
`;

  if (mode === "ethereal") {
    const account = await nodemailer.createTestAccount();
    const transporter = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: {
        user: account.user,
        pass: account.pass
      }
    });

    const info = await transporter.sendMail({
      to: "e2e@example.test",
      from: "agent@example.test",
      subject: `E2E Recommendation Flow: ${phaseResult.phase} phase complete`,
      html
    });

    logInfo("E2E email sent via Ethereal", {
      messageId: info.messageId,
      previewUrl: nodemailer.getTestMessageUrl(info)
    });

    return;
  }

  const emailTo = env.EMAIL_TO?.trim();
  const emailFrom = env.EMAIL_FROM?.trim();
  const host = env.SMTP_HOST?.trim();
  const port = Number(env.SMTP_PORT ?? "0");
  const secure = (env.SMTP_SECURE ?? "false").trim().toLowerCase() === "true";
  const smtpUser = env.SMTP_USER?.trim();
  const smtpPass = env.SMTP_PASS?.trim();

  if (!emailTo || !emailFrom || !host || !port || !smtpUser || !smtpPass) {
    throw new Error("SMTP mode requires EMAIL_TO, EMAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });

  const info = await transporter.sendMail({
    to: emailTo,
    from: emailFrom,
    subject: `E2E Recommendation Flow: ${phaseResult.phase} phase complete`,
    html
  });

  logInfo("E2E email sent via SMTP", { messageId: info.messageId, to: emailTo });
}

async function main(): Promise<void> {
  const env = schema.parse(process.env);

  const repositories = extractRepositoriesFromGithubEmail(env.E2E_RAW_EMAIL);
  if (!repositories.includes(env.E2E_TARGET_REPO)) {
    throw new Error(
      `Simulated email did not contain target repository ${env.E2E_TARGET_REPO}. Parsed: ${repositories.join(", ")}`
    );
  }

  const client = createGithubClient(env.GITHUB_TOKEN);
  const defaultBranch = await getDefaultBranch(client, env.E2E_TARGET_REPO);

  logInfo("Starting E2E recommendation simulation", {
    targetRepo: env.E2E_TARGET_REPO,
    library: env.E2E_LIBRARY,
    defaultBranch,
    emailMode: env.E2E_EMAIL_MODE
  });

  const addResult = await runPhase(
    env.GITHUB_TOKEN,
    env.E2E_TARGET_REPO,
    defaultBranch,
    env.E2E_LIBRARY,
    env.E2E_LIBRARY_VERSION,
    env.E2E_RAW_EMAIL,
    "add"
  );

  logInfo("Add phase completed", { ...addResult });

  await sendVerificationEmail(env.E2E_EMAIL_MODE, addResult, env);
  await mergePullRequest(env.GITHUB_TOKEN, env.E2E_TARGET_REPO, addResult.pullNumber, "add");

  const removeResult = await runPhase(
    env.GITHUB_TOKEN,
    env.E2E_TARGET_REPO,
    defaultBranch,
    env.E2E_LIBRARY,
    env.E2E_LIBRARY_VERSION,
    env.E2E_RAW_EMAIL,
    "remove"
  );

  logInfo("Remove phase completed", { ...removeResult });

  await sendVerificationEmail(env.E2E_EMAIL_MODE, removeResult, env);
  await mergePullRequest(env.GITHUB_TOKEN, env.E2E_TARGET_REPO, removeResult.pullNumber, "remove");

  logInfo("E2E recommendation simulation completed", {
    addPr: addResult.pullUrl,
    removePr: removeResult.pullUrl
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  logError("E2E recommendation simulation failed", { message });
  process.exitCode = 1;
});
