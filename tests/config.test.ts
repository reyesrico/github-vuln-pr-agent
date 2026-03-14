import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const originalEnv = { ...process.env };

function buildBaseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_TOKEN: "ghp_test",
    DRY_RUN: "true",
    VULN_SEVERITIES: "critical,high",
    BRANCH_PREFIX: "chore/security",
    MAX_ALERTS_PER_REPO: "2",
    REPO_COMMANDS: "{}",
    EMAIL_ENABLED: "false",
    ...overrides
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadConfig", () => {
  it("allows empty repository list for auto-discovery mode", () => {
    process.env = buildBaseEnv();

    const config = loadConfig();
    expect(config.repositories).toEqual([]);
  });

  it("extracts advisory signal from RAW_GITHUB_EMAIL", () => {
    process.env = buildBaseEnv({
      RAW_GITHUB_EMAIL: "High severity\ntar\nCVE-2026-31802\nAffected Repositories\nowner/repo"
    });

    const config = loadConfig();
    expect(config.alertSignal?.cveIds).toEqual(["CVE-2026-31802"]);
    expect(config.alertSignal?.dependencyNames).toEqual(["tar"]);
  });

  it("allows email fields to be omitted when EMAIL_ENABLED=false", () => {
    process.env = buildBaseEnv();

    const config = loadConfig();

    expect(config.email.enabled).toBe(false);
    expect(config.email.failOpen).toBe(true);
    expect(config.email.to).toBe("");
    expect(config.email.from).toBe("");
    expect(config.fixStrategy.retryWithLegacyPeerDeps).toBe(true);
  });

  it("allows disabling email fail-open", () => {
    process.env = buildBaseEnv({
      EMAIL_FAIL_OPEN: "false"
    });

    const config = loadConfig();
    expect(config.email.failOpen).toBe(false);
  });

  it("allows disabling retry with legacy peer deps", () => {
    process.env = buildBaseEnv({
      INSTALL_RETRY_WITH_LEGACY_PEER_DEPS: "false"
    });

    const config = loadConfig();
    expect(config.fixStrategy.retryWithLegacyPeerDeps).toBe(false);
  });

  it("requires EMAIL_TO and EMAIL_FROM when EMAIL_ENABLED=true", () => {
    process.env = buildBaseEnv({
      EMAIL_ENABLED: "true",
      SMTP_USER: "sender@example.com",
      SMTP_PASS: "app-pass"
    });

    expect(() => loadConfig()).toThrow(
      "EMAIL_TO and EMAIL_FROM are required when EMAIL_ENABLED=true."
    );
  });

  it("requires SMTP credentials when EMAIL_ENABLED=true", () => {
    process.env = buildBaseEnv({
      EMAIL_ENABLED: "true",
      EMAIL_TO: "alerts@example.com",
      EMAIL_FROM: "sender@example.com"
    });

    expect(() => loadConfig()).toThrow(
      "SMTP_USER and SMTP_PASS are required when EMAIL_ENABLED=true."
    );
  });
});
