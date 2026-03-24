import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { buildConfigPreflight } from "../src/utils/configPreflight.js";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    githubToken: "ghp_test",
    repositories: ["owner/repo"],
    processOnlyEmailSignal: true,
    dryRun: true,
    severities: ["critical", "high"],
    branchPrefix: "chore/security",
    maxAlertsPerRepo: 3,
    repoCommands: {},
    fixStrategy: {
      retryWithLegacyPeerDeps: true
    },
    preflightOnly: true,
    email: {
      enabled: false,
      failOpen: true,
      to: "",
      from: "",
      host: "smtp-mail.outlook.com",
      port: 587,
      secure: false
    },
    ...overrides
  };
}

describe("buildConfigPreflight", () => {
  it("includes repository and mode metadata", () => {
    const config = createConfig();
    const preflight = buildConfigPreflight(config, {
      GITHUB_TOKEN: "ghp_test",
      ALERT_REPOSITORIES: "owner/repo"
    });

    expect(preflight.mode).toBe("dry-run");
    expect(preflight.preflightOnly).toBe(true);
    expect(preflight.repositories).toEqual({ count: 1, sample: ["owner/repo"] });
    expect(preflight.repositoryDiscovery).toEqual({
      configuredList: true,
      viaGithubAdvisoryEmail: false,
      viaDispatchPayload: false,
      autoDiscoverAllOwnedRepos: false,
      accountLoginFilter: "(not set)"
    });
    expect(preflight.alertSelection).toEqual({
      processOnlyEmailSignal: true,
      emailSignalActive: false,
      cveIds: [],
      ghsaIds: [],
      dependencyNames: []
    });
    expect(preflight.fixStrategy).toEqual({ retryWithLegacyPeerDeps: true });
    expect(preflight.email).toEqual({
      enabled: false,
      failOpen: true,
      recipientConfigured: false,
      senderConfigured: false,
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpAuthConfigured: false
    });
  });

  it("reports missing email and smtp keys when email is enabled", () => {
    const config = createConfig({
      email: {
        enabled: true,
        failOpen: true,
        to: "alerts@example.com",
        from: "sender@example.com",
        host: "smtp-mail.outlook.com",
        port: 587,
        secure: false,
        user: "sender@example.com",
        pass: "app-pass"
      }
    });

    const preflight = buildConfigPreflight(config, {
      GITHUB_TOKEN: "ghp_test",
      ALERT_REPOSITORIES: "owner/repo"
    });

    expect(preflight.missingRequiredEnv).toEqual([
      "EMAIL_TO",
      "EMAIL_FROM",
      "SMTP_USER",
      "SMTP_PASS"
    ]);
  });
});
