import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../utils/exec.js";
import type { BatchFixInput, DependabotAlert, FixInput, FixResult, RepoCommands, FixStrategy } from "../types.js";

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

function createBatchBranchName(repoFullName: string, branchPrefix: string): string {
  const repoSegment = sanitizeBranchSegment(repoFullName.replace("/", "-"));
  const branch = `${branchPrefix}/${repoSegment}/batch-${createUniqueBranchSuffix()}`;
  return normalizeBranchName(branch);
}

function createFlatFallbackBatchBranchName(repoFullName: string, branchPrefix: string): string {
  const flatPrefix = sanitizeBranchSegment(branchPrefix).replace(/[/.]+/g, "-");
  const repoSegment = sanitizeBranchSegment(repoFullName.replace("/", "-"));
  const branch = `${flatPrefix}-${repoSegment}-batch-${createUniqueBranchSuffix()}`;
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

function uniqueInstallWorkingDirectories(repoDir: string, alerts: DependabotAlert[]): string[] {
  return [...new Set(alerts.map((alert) => resolveInstallWorkingDirectory(repoDir, alert.manifestPath)))];
}

async function alignOverrideInPackageJson(
  installWorkingDirectory: string,
  dependencyName: string,
  version: string
): Promise<{ success: boolean; output: string }> {
  const packageJsonPath = path.join(installWorkingDirectory, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };

    const applyVersionToDependencySection = (
      section: Record<string, string> | undefined,
      sectionName: string
    ): string[] => {
      if (!section || !section[dependencyName]) {
        return [];
      }

      section[dependencyName] = version;
      return [`Updated ${sectionName}.${dependencyName} to ${version}`];
    };

    const updates = [
      ...applyVersionToDependencySection(parsed.dependencies, "dependencies"),
      ...applyVersionToDependencySection(parsed.devDependencies, "devDependencies"),
      ...applyVersionToDependencySection(parsed.peerDependencies, "peerDependencies")
    ];

    // npm does not allow overriding a package that is already a direct dependency.
    // If the package appears in any dependency section, remove it from overrides instead
    // of updating it — keeping the override would cause EOVERRIDE on every subsequent install.
    const isDirectDependency =
      Boolean(parsed.dependencies?.[dependencyName]) ||
      Boolean(parsed.devDependencies?.[dependencyName]) ||
      Boolean(parsed.peerDependencies?.[dependencyName]);

    parsed.overrides = parsed.overrides ?? {};

    if (isDirectDependency) {
      if (parsed.overrides[dependencyName] !== undefined) {
        delete parsed.overrides[dependencyName];
        updates.push(`Removed overrides.${dependencyName} (conflicts with direct dependency)`);
      }

      for (const key of Object.keys(parsed.overrides)) {
        if (key.startsWith(`${dependencyName}@`)) {
          delete parsed.overrides[key];
          updates.push(`Removed overrides.${key} (conflicts with direct dependency)`);
        }
      }
    } else {
      parsed.overrides[dependencyName] = version;
      updates.push(`Updated overrides.${dependencyName} to ${version}`);

      for (const [key, value] of Object.entries(parsed.overrides)) {
        if (!key.startsWith(`${dependencyName}@`) || typeof value !== "string") {
          continue;
        }

        parsed.overrides[key] = version;
        updates.push(`Updated overrides.${key} to ${version}`);
      }
    }

    await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return {
      success: true,
      output: updates.join("; ")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      output: message
    };
  }
}

async function getInstallVersionSpec(
  installWorkingDirectory: string,
  dependencyName: string,
  patchedVersion?: string
): Promise<string> {
  if (!patchedVersion) {
    return "latest";
  }

  const packageJsonPath = path.join(installWorkingDirectory, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      overrides?: Record<string, string | Record<string, string>>;
    };

    const overrideValue = parsed.overrides?.[dependencyName];
    if (typeof overrideValue === "string" && overrideValue.includes(patchedVersion)) {
      return overrideValue;
    }
  } catch {
    // Fall back to patched version when package.json cannot be read or parsed.
  }

  return patchedVersion;
}

export function isGitRefNamespaceConflict(output: string): boolean {
  return /cannot lock ref 'refs\/heads\/.+': 'refs\/heads\/.+' exists; cannot create/i.test(output);
}

export function isNpmOverrideConflict(output: string): boolean {
  return /\bEOVERRIDE\b|Override for .+ conflicts with direct dependency/i.test(output);
}

/**
 * Extracts the package name that caused the EOVERRIDE conflict from npm error output.
 * e.g. "Override for node-forge@^1.4.0 conflicts with direct dependency" → "node-forge"
 */
export function extractOverrideConflictPackage(output: string): string | undefined {
  const match = /Override for ([^@\s]+)(?:@[^\s]*)? conflicts with direct dependency/i.exec(output);
  return match?.[1];
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
  private async runAuditFixWithFallbacks(
    installWorkingDirectory: string,
    strategy: FixStrategy
  ): Promise<void> {
    const auditCommand = "npm audit fix --package-lock-only";
    let auditResult = await runCommand(auditCommand, installWorkingDirectory);
    let legacyAttemptOutput: string | undefined;

    if (!auditResult.success && strategy.retryWithLegacyPeerDeps) {
      const retryCommand = withLegacyPeerDeps(auditCommand);
      const retryResult = await runCommand(retryCommand, installWorkingDirectory);

      if (retryResult.success) {
        auditResult = retryResult;
      } else {
        legacyAttemptOutput = retryResult.output;
      }
    }

    if (!auditResult.success) {
      if (legacyAttemptOutput) {
        throw new Error(
          `Audit fix failed after retry in ${installWorkingDirectory}: ${auditResult.output}\nRetry (${withLegacyPeerDeps(auditCommand)}) failed: ${legacyAttemptOutput}`
        );
      }

      throw new Error(`Audit fix failed in ${installWorkingDirectory}: ${auditResult.output}`);
    }
  }

  private async collectChangedFiles(repoDir: string): Promise<string[]> {
    const status = await runCommand("git status --porcelain", repoDir);
    if (!status.success) {
      throw new Error(`Unable to detect file changes: ${status.output}`);
    }

    return parseChangedFiles(status.output);
  }

  private async applyInstallCommandWithFallbacks(
    installCommand: string,
    installWorkingDirectory: string,
    alert: DependabotAlert,
    strategy: FixStrategy
  ): Promise<void> {
    let installResult = await runCommand(installCommand, installWorkingDirectory);
    let legacyAttemptOutput: string | undefined;

    if (!installResult.success && strategy.retryWithLegacyPeerDeps) {
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
        } else if (strategy.retryWithLegacyPeerDeps && canRetryWithLegacyPeerDeps(fallbackCommand)) {
          const retryFallbackCommand = withLegacyPeerDeps(fallbackCommand);
          const retryFallbackResult = await runCommand(retryFallbackCommand, installWorkingDirectory);

          if (retryFallbackResult.success) {
            installResult = retryFallbackResult;
          } else {
            // The EOVERRIDE may be caused by a pre-existing conflict for a different
            // package than the one being installed. Extract the actual conflicting
            // package name from the error so we remove the right override entry.
            const conflictPackage =
              extractOverrideConflictPackage(retryFallbackResult.output) ??
              alert.dependencyName;
            const alignOverrideResult = await alignOverrideInPackageJson(
              installWorkingDirectory,
              conflictPackage,
              alert.patchedVersion ?? ""
            );

            if (alignOverrideResult.success) {
              const postAlignRetry = await runCommand(retryFallbackCommand, installWorkingDirectory);
              if (postAlignRetry.success) {
                installResult = postAlignRetry;
              } else {
                throw new Error(
                  `Dependency update failed: ${installResult.output}\nRetry (${fallbackCommand}) failed: ${fallbackResult.output}\nRetry (${retryFallbackCommand}) failed: ${retryFallbackResult.output}\nOverride alignment did not recover install: ${postAlignRetry.output}`
                );
              }
            } else {
              throw new Error(
                `Dependency update failed: ${installResult.output}\nRetry (${fallbackCommand}) failed: ${fallbackResult.output}\nRetry (${retryFallbackCommand}) failed: ${retryFallbackResult.output}\nOverride alignment failed: ${alignOverrideResult.output}`
              );
            }
          }
        } else {
          throw new Error(
            `Dependency update failed: ${installResult.output}\nRetry (${fallbackCommand}) failed: ${fallbackResult.output}`
          );
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
  }

  private async buildInstallCommand(
    commands: RepoCommands,
    alert: DependabotAlert,
    installWorkingDirectory: string
  ): Promise<string> {
    if (commands.install) {
      return commands.install;
    }

    const versionSpec = await getInstallVersionSpec(
      installWorkingDirectory,
      alert.dependencyName,
      alert.patchedVersion
    );

    return `npm install ${alert.dependencyName}@${versionSpec} --package-lock-only`;
  }

  async applyFixBatch(input: BatchFixInput): Promise<FixResult> {
    if (input.alerts.length === 0) {
      return {
        repoFullName: input.repoFullName,
        branchName: "",
        changedFiles: [],
        localPath: "",
        commitMessage: "",
        skipped: true,
        reason: "No alerts provided for batch fix"
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

    let branchName = createBatchBranchName(input.repoFullName, input.branchPrefix);
    const checkout = await runCommand(`git checkout -b ${branchName}`, repoDir);
    if (!checkout.success) {
      throw new Error(`Branch creation failed: ${checkout.output}`);
    }

    const alertsWithPatchedVersion = input.alerts.filter((alert) => Boolean(alert.patchedVersion));
    const alertsWithoutPatchedVersion = input.alerts.filter((alert) => !alert.patchedVersion);

    for (const alert of alertsWithPatchedVersion) {
      const installWorkingDirectory = resolveInstallWorkingDirectory(repoDir, alert.manifestPath);
      const installCommand = await this.buildInstallCommand(
        input.commands,
        alert,
        installWorkingDirectory
      );
      await this.applyInstallCommandWithFallbacks(
        installCommand,
        installWorkingDirectory,
        alert,
        input.strategy
      );
    }

    if (alertsWithoutPatchedVersion.length > 0) {
      const auditDirs = uniqueInstallWorkingDirectories(repoDir, alertsWithoutPatchedVersion);
      for (const installWorkingDirectory of auditDirs) {
        await this.runAuditFixWithFallbacks(installWorkingDirectory, input.strategy);
      }
    }

    let changedFiles = await this.collectChangedFiles(repoDir);
    if (changedFiles.length === 0) {
      const allAuditDirs = uniqueInstallWorkingDirectories(repoDir, input.alerts);
      for (const installWorkingDirectory of allAuditDirs) {
        await this.runAuditFixWithFallbacks(installWorkingDirectory, input.strategy);
      }

      changedFiles = await this.collectChangedFiles(repoDir);
    }

    if (changedFiles.length === 0) {
      return {
        repoFullName: input.repoFullName,
        branchName,
        changedFiles,
        localPath: repoDir,
        commitMessage: "",
        skipped: true,
        reason: "No file changes after dependency updates and npm audit fix fallback"
      };
    }

    const dependencyList = input.alerts.map((alert) => alert.dependencyName).join(", ");
    const commitMessage = `fix(security): apply ${input.alerts.length} dependency updates (${dependencyList})`;

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
          const fallbackBranchName = createFlatFallbackBatchBranchName(
            input.repoFullName,
            input.branchPrefix
          );
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
      localPath: repoDir,
      commitMessage,
      skipped: false
    };
  }

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

    const batchResult = await this.applyFixBatch({
      repoFullName: input.repoFullName,
      alerts: [input.alert],
      branchPrefix: input.branchPrefix,
      githubToken: input.githubToken,
      dryRun: input.dryRun,
      commands: input.commands,
      strategy: input.strategy
    });

    if (!batchResult.skipped && input.alert.patchedVersion) {
      return {
        ...batchResult,
        commitMessage: `fix(security): bump ${input.alert.dependencyName} to ${input.alert.patchedVersion}`
      };
    }

    return batchResult;
  }
}
