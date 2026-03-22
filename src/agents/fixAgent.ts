import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../utils/exec.js";
import type { FixInput, FixResult } from "../types.js";

function sanitizeBranchSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function normalizeBranchName(input: string): string {
  const normalized = input
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .replace(/^\/+|\/+$/g, "");

  return normalized || "security-fix";
}

function createUniqueBranchSuffix(): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${randomPart}`;
}

function createPrimaryBranchName(input: FixInput): string {
  const branch = `${input.branchPrefix}-${sanitizeBranchSegment(input.alert.dependencyName)}-${sanitizeBranchSegment(input.alert.patchedVersion ?? "patch")}-alert-${input.alert.number}-${createUniqueBranchSuffix()}`;
  return normalizeBranchName(branch);
}

function createFlatFallbackBranchName(input: FixInput): string {
  const flatPrefix = sanitizeBranchSegment(input.branchPrefix).replace(/[/.]+/g, "-");
  const branch = `${flatPrefix}-${sanitizeBranchSegment(input.alert.dependencyName)}-${sanitizeBranchSegment(input.alert.patchedVersion ?? "patch")}-alert-${input.alert.number}-${createUniqueBranchSuffix()}`;
  return normalizeBranchName(branch);
}

function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export function resolveInstallWorkingDirectory(repoDir: string, manifestPath: string): string {
  const manifestDir = path.dirname(manifestPath || "package.json");
  const resolved = path.resolve(repoDir, manifestDir);

  // Keep execution inside cloned repository even if manifestPath is malformed.
  if (resolved === repoDir || resolved.startsWith(`${repoDir}${path.sep}`)) {
    return resolved;
  }

  return repoDir;
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

function includesPackageLockOnly(command: string): boolean {
  return command.includes("--package-lock-only");
}

function appendFlag(command: string, flag: string): string {
  if (command.includes(flag)) {
    return command;
  }

  return `${command} ${flag}`;
}

export function isGitRefNamespaceConflict(output: string): boolean {
  return /cannot lock ref 'refs\/heads\/.+': 'refs\/heads\/.+' exists; cannot create/i.test(output);
}

export function isNpmOverrideConflict(output: string): boolean {
  return /\bEOVERRIDE\b|Override for .+ conflicts with direct dependency/i.test(output);
}

export function createOverrideConflictFallbackCommand(command: string): string | undefined {
  if (!isNpmInstallCommand(command) || !includesPackageLockOnly(command)) {
    return undefined;
  }

  const withoutLockOnly = command
    .replace(/\s--package-lock-only\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return appendFlag(withoutLockOnly, "--save-exact");
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

    let branchName = createPrimaryBranchName(input);

    const checkout = await runCommand(`git checkout -b ${branchName}`, repoDir);
    if (!checkout.success) {
      throw new Error(`Branch creation failed: ${checkout.output}`);
    }

    const installWorkingDirectory = resolveInstallWorkingDirectory(
      repoDir,
      input.alert.manifestPath
    );

    const installCommand = input.commands.install
      ? input.commands.install
      : `npm install ${input.alert.dependencyName}@${input.alert.patchedVersion} --package-lock-only`;

    let installResult = await runCommand(installCommand, installWorkingDirectory);
    let legacyAttemptOutput: string | undefined;
    if (!installResult.success && input.strategy.retryWithLegacyPeerDeps) {
      if (canRetryWithLegacyPeerDeps(installCommand)) {
        const retryCommand = withLegacyPeerDeps(installCommand);
        const retryResult = await runCommand(retryCommand, installWorkingDirectory);

        if (retryResult.success) {
          installResult = retryResult;
        } else {
          legacyAttemptOutput = retryResult.output;
        }
      }
    }

    if (!installResult.success && isNpmOverrideConflict(installResult.output)) {
      const fallbackCommand = createOverrideConflictFallbackCommand(installCommand);
      if (fallbackCommand) {
        const fallbackResult = await runCommand(fallbackCommand, installWorkingDirectory);

        if (fallbackResult.success) {
          installResult = fallbackResult;
        } else {
          if (input.strategy.retryWithLegacyPeerDeps && canRetryWithLegacyPeerDeps(fallbackCommand)) {
            const retryFallbackCommand = withLegacyPeerDeps(fallbackCommand);
            const retryFallbackResult = await runCommand(
              retryFallbackCommand,
              installWorkingDirectory
            );
            if (retryFallbackResult.success) {
              installResult = retryFallbackResult;
            } else {
              throw new Error(
                `Dependency update failed: ${installResult.output}\nRetry (${fallbackCommand}) failed: ${fallbackResult.output}\nRetry (${retryFallbackCommand}) failed: ${retryFallbackResult.output}`
              );
            }
          } else {
            throw new Error(
              `Dependency update failed: ${installResult.output}\nRetry (${fallbackCommand}) failed: ${fallbackResult.output}`
            );
          }
        }
      }
    }

    if (!installResult.success) {
      if (legacyAttemptOutput) {
        throw new Error(
          `Dependency update failed after retry: ${installResult.output}\nRetry (${withLegacyPeerDeps(installCommand)}) failed: ${legacyAttemptOutput}`
        );
      }

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
        localPath: installWorkingDirectory,
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
        if (isGitRefNamespaceConflict(pushResult.output)) {
          const fallbackBranchName = createFlatFallbackBranchName(input);
          const renameResult = await runCommand(`git branch -m ${fallbackBranchName}`, repoDir);
          if (!renameResult.success) {
            throw new Error(
              `Git push failed due to ref namespace conflict: ${pushResult.output}\nBranch rename failed: ${renameResult.output}`
            );
          }

          const retryPushResult = await runCommand(`git push origin ${fallbackBranchName}`, repoDir);
          if (!retryPushResult.success) {
            throw new Error(
              `Git push failed: ${pushResult.output}\nRetry push with fallback branch (${fallbackBranchName}) failed: ${retryPushResult.output}`
            );
          }

          branchName = fallbackBranchName;
        } else {
          throw new Error(`Git push failed: ${pushResult.output}`);
        }
      }
    }

    return {
      repoFullName: input.repoFullName,
      branchName,
      changedFiles,
      localPath: installWorkingDirectory,
      commitMessage,
      skipped: false
    };
  }
}
