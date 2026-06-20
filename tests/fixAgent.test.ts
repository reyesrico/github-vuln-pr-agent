import { describe, expect, it } from "vitest";

import {
  createOverrideConflictFallbackCommand,
  isGitRefNamespaceConflict,
  isNpmOverrideConflict,
  isSameMajorUpgrade,
  parseMajorVersion,
  resolveInstallWorkingDirectory
} from "../src/agents/fixAgent.js";

describe("fixAgent helpers", () => {
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
