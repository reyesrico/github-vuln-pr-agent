import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const originalEnv = { ...process.env };

function buildBaseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_TOKEN: "ghp_test",
    ALERT_REPOSITORIES: "owner/repo",
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
  it("allows email fields to be omitted when EMAIL_ENABLED=false", () => {
    process.env = buildBaseEnv();

    const config = loadConfig();

    expect(config.email.enabled).toBe(false);
    expect(config.email.to).toBe("");
    expect(config.email.from).toBe("");
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
