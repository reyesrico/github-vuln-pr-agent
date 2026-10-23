import { afterEach, describe, expect, it } from "vitest";

import {
  createOverrideConflictFallbackCommand,
  dependencyResolvedInLockFile,
  isGitRefNamespaceConflict,
  isNpmOverrideConflict,
  isSameMajorUpgrade,
  parseMajorVersion,
  parseChangedFiles,
  resolveInstallWorkingDirectory
} from "../src/agents/fixAgent.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("fixAgent helpers", () => {
  it("preserves filenames when parsing staged and unstaged changes", () => {
    expect(parseChangedFiles(" M package.json\nM  package-lock.json\n?? new-file.json\n")).toEqual([
      "package.json", "package-lock.json", "new-file.json"
    ]);
  });

  it("detects git ref namespace conflicts", () => {
    const output =
      "cannot lock ref 'refs/heads/chore/security/pkg/1.2.3/alert-1/x': 'refs/heads/chore/security/pkg/1.2.3' exists; cannot create";

    expect(isGitRefNamespaceConflict(output)).toBe(true);
  });

  it("detects npm override conflicts", () => {
    const output = "npm error code EOVERRIDE npm error Override for undici@7.24.0 conflicts with direct dependency";

    expect(isNpmOverrideConflict(output)).toBe(true);
  });

  it("creates fallback install command when package-lock-only is present", () => {
    const command = "npm install undici@7.24.0 --package-lock-only";

    expect(createOverrideConflictFallbackCommand(command)).toBe(
      "npm install undici@7.24.0 --save-exact"
    );
  });

  it("does not create fallback command for non npm install commands", () => {
    const command = "npm ci --package-lock-only";

    expect(createOverrideConflictFallbackCommand(command)).toBeUndefined();
  });

  it("resolves install working directory from alert manifest path", () => {
    const repo = "/tmp/repo";
    const resolved = resolveInstallWorkingDirectory(repo, "apps/web/package-lock.json");

    expect(resolved).toBe("/tmp/repo/apps/web");
  });

  it("falls back to repo root for unsafe manifest paths", () => {
    const repo = "/tmp/repo";
    const resolved = resolveInstallWorkingDirectory(repo, "../../outside/package-lock.json");

    expect(resolved).toBe(repo);
  });

  it("parses the major version from a plain version", () => {
    expect(parseMajorVersion("7.24.4")).toBe(7);
    expect(parseMajorVersion("0.27.3")).toBe(0);
  });

  it("parses the major version from a ranged or prefixed version", () => {
    expect(parseMajorVersion("^7.28.0")).toBe(7);
    expect(parseMajorVersion(">=5.2.0")).toBe(5);
    expect(parseMajorVersion("v11.1.1")).toBe(11);
  });

  it("returns undefined for an unparseable version", () => {
    expect(parseMajorVersion("latest")).toBeUndefined();
    expect(parseMajorVersion("")).toBeUndefined();
  });

  it("treats same-major bumps as semver-compatible", () => {
    expect(isSameMajorUpgrade("7.24.4", "7.28.0")).toBe(true);
    expect(isSameMajorUpgrade("0.27.3", "0.28.1")).toBe(true);
    expect(isSameMajorUpgrade("5.1.4", "5.2.0")).toBe(true);
  });

  it("treats cross-major bumps as breaking", () => {
    expect(isSameMajorUpgrade("8.3.2", "11.1.1")).toBe(false);
    expect(isSameMajorUpgrade("6.12.6", "7.0.0")).toBe(false);
  });

  it("returns false when either version is unparseable", () => {
    expect(isSameMajorUpgrade("latest", "7.28.0")).toBe(false);
    expect(isSameMajorUpgrade("7.24.4", "")).toBe(false);
  });
});

describe("dependencyResolvedInLockFile", () => {
  async function writeLock(packages: Record<string, { version?: string }>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "lock-"));
    directories.push(dir);
    const lockFilePath = path.join(dir, "package-lock.json");
    await writeFile(lockFilePath, JSON.stringify({ packages }), "utf8");
    return lockFilePath;
  }

  it("returns true when the top-level dependency meets the patched version", async () => {
    const lockFilePath = await writeLock({
      "node_modules/@hono/node-server": { version: "2.0.10" }
    });

    expect(
      await dependencyResolvedInLockFile(lockFilePath, "@hono/node-server", "2.0.5")
    ).toBe(true);
  });

  it("returns false when the dependency is still below the patched version", async () => {
    const lockFilePath = await writeLock({
      "node_modules/@hono/node-server": { version: "1.19.17" }
    });

    expect(
      await dependencyResolvedInLockFile(lockFilePath, "@hono/node-server", "2.0.5")
    ).toBe(false);
  });

  it("returns false when a nested copy remains below the patched version", async () => {
    const lockFilePath = await writeLock({
      "node_modules/@hono/node-server": { version: "2.0.10" },
      "node_modules/some-parent/node_modules/@hono/node-server": { version: "1.19.17" }
    });

    expect(
      await dependencyResolvedInLockFile(lockFilePath, "@hono/node-server", "2.0.5")
    ).toBe(false);
  });

  it("returns true when the dependency is absent from the lock file", async () => {
    const lockFilePath = await writeLock({
      "node_modules/other-pkg": { version: "1.0.0" }
    });

    expect(await dependencyResolvedInLockFile(lockFilePath, "undici", "7.28.0")).toBe(true);
  });

  it("fails closed when the lock file cannot be read", async () => {
    await expect(
      dependencyResolvedInLockFile("/nonexistent/package-lock.json", "undici", "7.28.0")
    ).rejects.toThrow();
  });

  it("does not verify an installed package without a published patch", async () => {
    const lockFilePath = await writeLock({ "node_modules/sprintf-js": { version: "1.0.3" } });
    expect(await dependencyResolvedInLockFile(lockFilePath, "sprintf-js")).toBe(false);
  });

  it("verifies removal when no patch is published", async () => {
    const lockFilePath = await writeLock({ "node_modules/other": { version: "1.0.0" } });
    expect(await dependencyResolvedInLockFile(lockFilePath, "sprintf-js")).toBe(true);
  });

  it("checks nested copies even when the unpatched package is not hoisted", async () => {
    const lockFilePath = await writeLock({
      "node_modules/parent/node_modules/sprintf-js": { version: "1.0.3" }
    });
    expect(await dependencyResolvedInLockFile(lockFilePath, "sprintf-js")).toBe(false);
  });

  it("rejects missing and malformed installed versions", async () => {
    for (const version of [undefined, "invalid", "7.28.0-beta.1"]) {
      const lockFilePath = await writeLock({
        "node_modules/undici": version === undefined ? {} : { version }
      });
      expect(await dependencyResolvedInLockFile(lockFilePath, "undici", "7.28.0")).toBe(false);
    }
  });

  it("rejects malformed and unsupported lockfiles", async () => {
    const lockFilePath = await writeLock({});
    for (const contents of ["{", "{}", '{"lockfileVersion":1,"dependencies":{}}', '{"packages":null}']) {
      await writeFile(lockFilePath, contents);
      await expect(dependencyResolvedInLockFile(lockFilePath, "undici", "7.28.0")).rejects.toThrow();
    }
  });
});
