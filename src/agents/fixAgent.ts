import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../utils/exec.js";
import type { FixInput, FixResult } from "../types.js";

function sanitizeBranchSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function createUniqueBranchSuffix(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${randomPart}`;
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function isNpmInstallCommand(command: string): boolean {
  return /(^|\s)npm\s+install(\s|$)/.test(command);
}

function canRetryWithLegacyPeerDeps(command: string): boolean {
  if (!isNpmInstallCommand(command)) {
    return false;
  }

  return !command.includes("--legacy-peer-deps");
}

function withLegacyPeerDeps(command: string): string {
  return `${command} --legacy-peer-deps`;
}

export class FixAgent {
  async applyFix(input: FixInput): Promise<FixResult> {
    if (!input.alert.patchedVersion) {
      return {
        repoFullName: input.repoFullName,
        branchName: "",
        changedFiles: [],
        localPath: "",
        commitMessage: "",
        skipped: true,
        reason: "No patched version provided by Dependabot alert"
      };
    }

    const tmpBase = await mkdtemp(path.join(os.tmpdir(), "vuln-pr-agent-"));
    const repoDir = path.join(tmpBase, input.repoFullName.replace("/", "__"));
    const encodedToken = encodeURIComponent(input.githubToken);
    const cloneUrl = `https://x-access-token:${encodedToken}@github.com/${input.repoFullName}.git`;

    const cloneResult = await runCommand(`git clone --depth 1 ${cloneUrl} ${repoDir}`, tmpBase);
    if (!cloneResult.success) {
      throw new Error(`Clone failed for ${input.repoFullName}: ${cloneResult.output}`);
    }

    const branchName = `${input.branchPrefix}-${sanitizeBranchSegment(input.alert.dependencyName)}-${sanitizeBranchSegment(input.alert.patchedVersion)}-alert-${input.alert.number}-${createUniqueBranchSuffix()}`;

    const checkout = await runCommand(`git checkout -b ${branchName}`, repoDir);
    if (!checkout.success) {
      throw new Error(`Branch creation failed: ${checkout.output}`);
    }

    const installCommand = input.commands.install
      ? input.commands.install
      : `npm install ${input.alert.dependencyName}@${input.alert.patchedVersion} --package-lock-only`;

    let installResult = await runCommand(installCommand, repoDir);
    if (!installResult.success && input.strategy.retryWithLegacyPeerDeps) {
      if (canRetryWithLegacyPeerDeps(installCommand)) {
        const retryCommand = withLegacyPeerDeps(installCommand);
        const retryResult = await runCommand(retryCommand, repoDir);

        if (retryResult.success) {
          installResult = retryResult;
        } else {
          throw new Error(
            `Dependency update failed after retry: ${installResult.output}\nRetry (${retryCommand}) failed: ${retryResult.output}`
          );
        }
      }
    }

    if (!installResult.success) {
      throw new Error(`Dependency update failed: ${installResult.output}`);
    }

    const status = await runCommand("git status --porcelain", repoDir);
    if (!status.success) {
      throw new Error(`Unable to detect file changes: ${status.output}`);
    }

    const changedFiles = parseChangedFiles(status.output);
    if (changedFiles.length === 0) {
      return {
        repoFullName: input.repoFullName,
        branchName,
        changedFiles,
        localPath: repoDir,
        commitMessage: "",
        skipped: true,
        reason: "No file changes after dependency update"
      };
    }

    const commitMessage = `fix(security): bump ${input.alert.dependencyName} to ${input.alert.patchedVersion}`;

    const addResult = await runCommand("git add -A", repoDir);
    if (!addResult.success) {
      throw new Error(`Git add failed: ${addResult.output}`);
    }

    const commitResult = await runCommand(
      `git -c user.name="Security Agent" -c user.email="security-agent@users.noreply.github.com" commit -m "${commitMessage}"`,
      repoDir
    );
    if (!commitResult.success) {
      throw new Error(`Git commit failed: ${commitResult.output}`);
    }

    if (!input.dryRun) {
      const pushResult = await runCommand(`git push origin ${branchName}`, repoDir);
      if (!pushResult.success) {
        throw new Error(`Git push failed: ${pushResult.output}`);
      }
    }

    return {
      repoFullName: input.repoFullName,
      branchName,
      changedFiles,
      localPath: repoDir,
      commitMessage,
      skipped: false
    };
  }
}
