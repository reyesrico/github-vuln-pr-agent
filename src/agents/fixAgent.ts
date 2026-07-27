import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../utils/exec.js";
import type { BatchFixInput, DependabotAlert, FixInput, FixResult, RepoCommands, FixStrategy } from "../types.js";
import { resolveNodeRuntime, type NodeRuntime, wrapCommandWithNodeRuntime } from "../utils/nodeRuntime.js";

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

function isVersionBelow(version: string, minVersion: string): boolean {
  const vParts = version.split(".").map(Number);
  const mParts = minVersion.split(".").map(Number);

  for (let i = 0; i < Math.max(vParts.length, mParts.length); i++) {
    const v = vParts[i] ?? 0;
    const m = mParts[i] ?? 0;

    if (v < m) return true;
    if (v > m) return false;
  }

  return false;
}

async function findNestedParentsInLockFile(
  lockFilePath: string,
  depName: string,
  patchedVersion: string
): Promise<string[]> {
  try {
    const raw = await readFile(lockFilePath, "utf8");
    const lock = JSON.parse(raw) as { packages?: Record<string, { version?: string }> };
    const packages = lock.packages ?? {};
    const parents = new Set<string>();
    const escapedDep = depName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nestedPattern = new RegExp(`^node_modules/(.+)/node_modules/${escapedDep}$`);

    for (const [key, pkg] of Object.entries(packages)) {
      const match = nestedPattern.exec(key);

      if (match && pkg.version && isVersionBelow(pkg.version, patchedVersion)) {
        const parentPath = match[1];

        if (parentPath) {
          const parentName = parentPath.split("/node_modules/").pop();

          if (parentName) {
            parents.add(parentName);
          }
        }
      }
    }

    return [...parents];
  } catch {
    return [];
  }
}

async function addScopedDepOverrides(
  packageJsonPath: string,
  parentNames: string[],
  depName: string,
  patchedVersion: string
): Promise<boolean> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      overrides?: Record<string, string | Record<string, string>>;
    };

    parsed.overrides = parsed.overrides ?? {};
    let modified = false;
    // Use caret range to stay within the same major version.
    // '>=' would resolve to the latest overall (e.g. json5@2.x for >=1.0.2), which
    // can be a breaking API change for the parent package.
    const versionSpec = `^${patchedVersion}`;

    for (const parent of parentNames) {
      const existing = parsed.overrides[parent];

      if (existing !== null && typeof existing === "object") {
        if (existing[depName] !== versionSpec) {
          existing[depName] = versionSpec;
          modified = true;
        }
      } else {
        parsed.overrides[parent] = { [depName]: versionSpec };
        modified = true;
      }
    }

    if (modified) {
      await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    }

    return modified;
  } catch {
    return false;
  }
}

async function deleteNestedLockEntries(
  lockFilePath: string,
  parentNames: string[],
  depName: string
): Promise<boolean> {
  try {
    const raw = await readFile(lockFilePath, "utf8");
    const lock = JSON.parse(raw) as { packages?: Record<string, unknown> };
    const packages = lock.packages;

    if (!packages) {
      return false;
    }

    let deleted = false;
    const escapedDep = depName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    for (const parent of parentNames) {
      const escapedParent = parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `^node_modules/(?:.+/node_modules/)?${escapedParent}/node_modules/${escapedDep}$`
      );

      for (const key of Object.keys(packages)) {
        if (pattern.test(key)) {
          delete packages[key];
          deleted = true;
        }
      }
    }

    if (deleted) {
      await writeFile(lockFilePath, JSON.stringify(lock, null, 2) + "\n", "utf8");
    }

    return deleted;
  } catch {
    return false;
  }
}

export function parseMajorVersion(version: string): number | undefined {
  const cleaned = version.replace(/^[^0-9]*/, "");
  const match = /^(\d+)/.exec(cleaned);
  return match ? Number(match[1]) : undefined;
}

/**
 * Returns true when upgrading from `installedVersion` to `patchedVersion` stays within
 * the same numeric major version (a semver-compatible, non-breaking bump). This is the
 * gate for the automatic top-level override remediation: same-major bumps are forced,
 * cross-major gaps are left for manual review. The downstream build/test step is the
 * safety net for 0.x minor bumps where semver allows breaking changes.
 */
export function isSameMajorUpgrade(installedVersion: string, patchedVersion: string): boolean {
  const installedMajor = parseMajorVersion(installedVersion);
  const patchedMajor = parseMajorVersion(patchedVersion);

  if (installedMajor === undefined || patchedMajor === undefined) {
    return false;
  }

  return installedMajor === patchedMajor;
}

async function readTopLevelInstalledVersion(
  lockFilePath: string,
  depName: string
): Promise<string | undefined> {
  try {
    const raw = await readFile(lockFilePath, "utf8");
    const lock = JSON.parse(raw) as { packages?: Record<string, { version?: string }> };
    return lock.packages?.[`node_modules/${depName}`]?.version;
  } catch {
    return undefined;
  }
}

/**
 * Scans a package-lock.json for every installed copy of `depName` (top-level and nested)
 * and returns true only when no copy remains below `patchedVersion` — i.e. the advisory is
 * actually resolved by the fix. Returns true when the lock file cannot be read so a transient
 * read error never downgrades a legitimately created fix.
 */
export async function dependencyResolvedInLockFile(
  lockFilePath: string,
  depName: string,
  patchedVersion: string
): Promise<boolean> {
  try {
    const raw = await readFile(lockFilePath, "utf8");
    const lock = JSON.parse(raw) as { packages?: Record<string, { version?: string }> };
    const packages = lock.packages ?? {};
    const escapedDep = depName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|/)node_modules/${escapedDep}$`);

    for (const [key, pkg] of Object.entries(packages)) {
      if (pattern.test(key) && pkg.version && isVersionBelow(pkg.version, patchedVersion)) {
        return false;
      }
    }

    return true;
  } catch {
    return true;
  }
}

async function dependencyIsDirect(packageJsonPath: string, depName: string): Promise<boolean> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    return Boolean(
      parsed.dependencies?.[depName] ||
        parsed.devDependencies?.[depName] ||
        parsed.peerDependencies?.[depName]
    );
  } catch {
    return false;
  }
}

async function addTopLevelOverride(
  packageJsonPath: string,
  depName: string,
  patchedVersion: string
): Promise<boolean> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      overrides?: Record<string, string | Record<string, string>>;
    };

    parsed.overrides = parsed.overrides ?? {};
    // Caret range keeps the resolution within the same major version.
    const versionSpec = `^${patchedVersion}`;

    if (parsed.overrides[depName] === versionSpec) {
      return false;
    }

    parsed.overrides[depName] = versionSpec;
    await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function deleteTopLevelLockEntry(lockFilePath: string, depName: string): Promise<boolean> {
  try {
    const raw = await readFile(lockFilePath, "utf8");
    const lock = JSON.parse(raw) as { packages?: Record<string, unknown> };
    const packages = lock.packages;

    if (!packages) {
      return false;
    }

    const key = `node_modules/${depName}`;
    if (key in packages) {
      delete packages[key];
      await writeFile(lockFilePath, JSON.stringify(lock, null, 2) + "\n", "utf8");
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function parseMinRequiredNodeMajor(output: string): number | undefined {
  const patterns = [
    /EBADENGINE[^\n]*required[^\n]*node@?>=?(\d+)/i,
    /requires? node@?>=?(\d+)/i,
    /engine.*node.*>=\s*(\d+)/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(output);
    const major = match?.[1];
    if (major) {
      return Number(major);
    }
  }

  return undefined;
}

async function bumpNodeVersionInManifest(
  packageJsonPath: string,
  requiredMajor: number
): Promise<boolean> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { engines?: { node?: string } };
    const currentSpec = parsed.engines?.node ?? "";
    const currentMajorMatch = /(\d+)/.exec(currentSpec);
    const currentMajor = currentMajorMatch ? Number(currentMajorMatch[1]) : 0;

    if (currentMajor >= requiredMajor) {
      return false;
    }

    parsed.engines = parsed.engines ?? {};
    parsed.engines.node = `>=${requiredMajor}`;
    await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
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
  private async tryAuditFixWithFallbacks(
    installWorkingDirectory: string,
    strategy: FixStrategy,
    runtime: NodeRuntime
  ): Promise<string | undefined> {
    const auditCommand = "npm audit fix --package-lock-only";
    let auditResult = await runCommand(
      wrapCommandWithNodeRuntime(auditCommand, runtime),
      installWorkingDirectory
    );
    let legacyAttemptOutput: string | undefined;

    if (!auditResult.success && strategy.retryWithLegacyPeerDeps) {
      const retryCommand = withLegacyPeerDeps(auditCommand);
      const retryResult = await runCommand(
        wrapCommandWithNodeRuntime(retryCommand, runtime),
        installWorkingDirectory
      );

      if (retryResult.success) {
        auditResult = retryResult;
      } else {
        legacyAttemptOutput = retryResult.output;
      }
    }

    if (!auditResult.success) {
      if (legacyAttemptOutput) {
        return `Audit fix failed after retry in ${installWorkingDirectory}: ${auditResult.output}\nRetry (${withLegacyPeerDeps(auditCommand)}) failed: ${legacyAttemptOutput}`;
      }

      return `Audit fix failed in ${installWorkingDirectory}: ${auditResult.output}`;
    }

    return undefined;
  }

  private async collectChangedFiles(repoDir: string): Promise<string[]> {
    const status = await runCommand("git status --porcelain", repoDir);
    if (!status.success) {
      throw new Error(`Unable to detect file changes: ${status.output}`);
    }

    return parseChangedFiles(status.output);
  }

  private async tryNodeVersionUpgrade(
    repoDir: string,
    auditOutput: string
  ): Promise<boolean> {
    const requiredMajor = parseMinRequiredNodeMajor(auditOutput);
    if (!requiredMajor) {
      return false;
    }

    const packageJsonPath = path.join(repoDir, "package.json");
    const bumped = await bumpNodeVersionInManifest(packageJsonPath, requiredMajor);

    if (bumped) {
      for (const versionFile of [".nvmrc", ".node-version"]) {
        const filePath = path.join(repoDir, versionFile);
        try {
          const current = (await readFile(filePath, "utf8")).trim();
          const currentMajorMatch = /(\d+)/.exec(current);
          const currentMajor = currentMajorMatch ? Number(currentMajorMatch[1]) : 0;
          if (currentMajor < requiredMajor) {
            await writeFile(filePath, `${requiredMajor}\n`, "utf8");
          }
        } catch {
          // File does not exist; skip.
        }
      }
    }

    return bumped;
  }

  // NOTE: applyInstallCommandWithFallbacks intentionally removed.
  // The primary fix strategy is now npm audit fix (see applyFixBatch Phase 1).
  // Targeted per-alert installs were replaced by audit fix + scoped override supplements.
  private async applyInstallCommandWithFallbacks(
    installCommand: string,
    installWorkingDirectory: string,
    alert: DependabotAlert,
    strategy: FixStrategy,
    runtime: NodeRuntime
  ): Promise<void> {
    let installResult = await runCommand(
      wrapCommandWithNodeRuntime(installCommand, runtime),
      installWorkingDirectory
    );
    let legacyAttemptOutput: string | undefined;

    if (!installResult.success && strategy.retryWithLegacyPeerDeps) {
      if (canRetryWithLegacyPeerDeps(installCommand)) {
        const retryCommand = withLegacyPeerDeps(installCommand);
        const retryResult = await runCommand(
          wrapCommandWithNodeRuntime(retryCommand, runtime),
          installWorkingDirectory
        );

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
        const fallbackResult = await runCommand(
          wrapCommandWithNodeRuntime(fallbackCommand, runtime),
          installWorkingDirectory
        );

        if (fallbackResult.success) {
          installResult = fallbackResult;
        } else if (strategy.retryWithLegacyPeerDeps && canRetryWithLegacyPeerDeps(fallbackCommand)) {
          const retryFallbackCommand = withLegacyPeerDeps(fallbackCommand);
          const retryFallbackResult = await runCommand(
            wrapCommandWithNodeRuntime(retryFallbackCommand, runtime),
            installWorkingDirectory
          );

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
              const postAlignRetry = await runCommand(
                wrapCommandWithNodeRuntime(retryFallbackCommand, runtime),
                installWorkingDirectory
              );
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

    const runtime = await resolveNodeRuntime(repoDir, input.commands.nodeVersion);

    const allManifestDirs = uniqueInstallWorkingDirectories(repoDir, input.alerts);
    const auditErrors: string[] = [];

    // Phase 1: npm audit fix --package-lock-only (primary strategy).
    // Resolves all automatically-patchable vulnerabilities in one pass — more reliable
    // than per-alert installs because npm uses its own advisory graph to select safe
    // version ranges rather than relying on the exact patchedVersion from Dependabot.
    for (const installWorkingDirectory of allManifestDirs) {
      const error = await this.tryAuditFixWithFallbacks(installWorkingDirectory, input.strategy, runtime);
      if (error) {
        auditErrors.push(error);
      }
    }

    // Phase 2: Scoped overrides for transitive nested copies not resolved by audit fix.
    // Some parent packages pin an exact older version of a dep; npm audit fix leaves
    // those nested copies untouched. We write a scoped npm override (overrides.parent.dep)
    // and delete the stale lock entry so npm regenerates it using the patched version.
    const alertsWithPatchedVersion = input.alerts.filter((alert) => Boolean(alert.patchedVersion));
    for (const alert of alertsWithPatchedVersion) {
      if (!alert.patchedVersion) continue;

      const installWorkingDirectory = resolveInstallWorkingDirectory(repoDir, alert.manifestPath);
      const lockFilePath = path.join(installWorkingDirectory, "package-lock.json");
      const nestedParents = await findNestedParentsInLockFile(
        lockFilePath,
        alert.dependencyName,
        alert.patchedVersion
      );

      if (nestedParents.length > 0) {
        const packageJsonPath = path.join(installWorkingDirectory, "package.json");
        const overrideAdded = await addScopedDepOverrides(
          packageJsonPath,
          nestedParents,
          alert.dependencyName,
          alert.patchedVersion
        );

        if (overrideAdded) {
          await deleteNestedLockEntries(lockFilePath, nestedParents, alert.dependencyName);

          const nestedInstallResult = await runCommand(
            wrapCommandWithNodeRuntime("npm install --package-lock-only", runtime),
            installWorkingDirectory
          );
          if (!nestedInstallResult.success && input.strategy.retryWithLegacyPeerDeps) {
            await runCommand(
              wrapCommandWithNodeRuntime("npm install --package-lock-only --legacy-peer-deps", runtime),
              installWorkingDirectory
            );
          }
        }
      }
    }

    // Phase 2b: Top-level overrides for hoisted transitive deps audit fix could not patch.
    // When a vulnerable transitive is hoisted to the top of node_modules and a parent pins
    // an older range (common with Angular build tooling), npm audit fix leaves it untouched —
    // only `npm audit fix --force` (a breaking upgrade) would move it, so the batch would
    // otherwise be skipped as "breaking-upgrade". If the patched version is within the SAME
    // MAJOR as the installed version, it is a semver-compatible bump: force it via a top-level
    // npm override and let the downstream build/test gate validate it. Cross-major gaps and
    // direct dependencies are left untouched (handled elsewhere / manual review).
    for (const alert of alertsWithPatchedVersion) {
      if (!alert.patchedVersion) continue;

      const installWorkingDirectory = resolveInstallWorkingDirectory(repoDir, alert.manifestPath);
      const lockFilePath = path.join(installWorkingDirectory, "package-lock.json");
      const packageJsonPath = path.join(installWorkingDirectory, "package.json");

      const installedVersion = await readTopLevelInstalledVersion(lockFilePath, alert.dependencyName);
      if (!installedVersion) continue;

      // Already at or above the patched version (resolved by Phase 1 or Phase 2).
      if (!isVersionBelow(installedVersion, alert.patchedVersion)) continue;

      // Overriding a direct dependency triggers EOVERRIDE; those go through the install path.
      if (await dependencyIsDirect(packageJsonPath, alert.dependencyName)) continue;

      // Only force semver-compatible (same-major) bumps automatically.
      if (!isSameMajorUpgrade(installedVersion, alert.patchedVersion)) continue;

      const overrideAdded = await addTopLevelOverride(
        packageJsonPath,
        alert.dependencyName,
        alert.patchedVersion
      );

      if (overrideAdded) {
        await deleteTopLevelLockEntry(lockFilePath, alert.dependencyName);

        const topLevelInstallResult = await runCommand(
          wrapCommandWithNodeRuntime("npm install --package-lock-only", runtime),
          installWorkingDirectory
        );
        if (!topLevelInstallResult.success && input.strategy.retryWithLegacyPeerDeps) {
          await runCommand(
            wrapCommandWithNodeRuntime("npm install --package-lock-only --legacy-peer-deps", runtime),
            installWorkingDirectory
          );
        }
      }
    }

    // Phase 3: Node version upgrade.
    // If audit output contains EBADENGINE or "requires node >= X", bump the repo's
    // engines.node (and .nvmrc/.node-version if present) to the required major, then
    // re-run audit fix with the updated runtime so packages that needed a newer Node
    // can now resolve to their patched versions.
    const combinedAuditOutput = auditErrors.join("\n");
    const nodeVersionBumped = await this.tryNodeVersionUpgrade(repoDir, combinedAuditOutput);

    if (nodeVersionBumped) {
      const updatedRuntime = await resolveNodeRuntime(repoDir, input.commands.nodeVersion);
      for (const installWorkingDirectory of allManifestDirs) {
        await this.tryAuditFixWithFallbacks(installWorkingDirectory, input.strategy, updatedRuntime);
      }
    }

    const changedFiles = await this.collectChangedFiles(repoDir);

    if (changedFiles.length === 0) {
      return {
        repoFullName: input.repoFullName,
        branchName,
        changedFiles,
        localPath: repoDir,
        commitMessage: "",
        skipped: true,
        reason:
          auditErrors.length > 0
            ? `No file changes after npm audit fix; ${auditErrors[0]}`
            : "No file changes after npm audit fix"
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
