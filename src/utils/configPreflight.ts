import type { AppConfig } from "../config.js";

function hasValue(value?: string): boolean {
  return Boolean(value && value.trim());
}

export function buildConfigPreflight(
  config: AppConfig,
  env: NodeJS.ProcessEnv
): Record<string, unknown> {
  const missingRequiredEnv: string[] = [];

  if (!hasValue(env.GITHUB_TOKEN)) {
    missingRequiredEnv.push("GITHUB_TOKEN");
  }

  if (config.email.enabled) {
    if (!hasValue(env.EMAIL_TO)) {
      missingRequiredEnv.push("EMAIL_TO");
    }
    if (!hasValue(env.EMAIL_FROM)) {
      missingRequiredEnv.push("EMAIL_FROM");
    }
    if (!hasValue(env.SMTP_USER)) {
      missingRequiredEnv.push("SMTP_USER");
    }
    if (!hasValue(env.SMTP_PASS)) {
      missingRequiredEnv.push("SMTP_PASS");
    }
  }

  return {
    mode: config.dryRun ? "dry-run" : "live",
    preflightOnly: config.preflightOnly,
    repositories: {
      count: config.repositories.length,
      sample: config.repositories.slice(0, 3)
    },
    repositoryDiscovery: {
      configuredList: hasValue(env.ALERT_REPOSITORIES),
      viaGithubAdvisoryEmail: hasValue(env.RAW_GITHUB_EMAIL),
      autoDiscoverAllOwnedRepos: !hasValue(env.ALERT_REPOSITORIES) && !hasValue(env.RAW_GITHUB_EMAIL),
      accountLoginFilter: config.accountLogin ?? "(not set)"
    },
    alertSelection: {
      processOnlyEmailSignal: config.processOnlyEmailSignal,
      emailSignalActive: Boolean(
        config.alertSignal?.cveIds.length ||
          config.alertSignal?.ghsaIds.length ||
          config.alertSignal?.dependencyNames.length
      ),
      cveIds: config.alertSignal?.cveIds ?? [],
      ghsaIds: config.alertSignal?.ghsaIds ?? [],
      dependencyNames: config.alertSignal?.dependencyNames ?? []
    },
    severities: config.severities,
    branchPrefix: config.branchPrefix,
    maxAlertsPerRepo: config.maxAlertsPerRepo,
    repoCommandOverrides: Object.keys(config.repoCommands).length,
    fixStrategy: {
      retryWithLegacyPeerDeps: config.fixStrategy.retryWithLegacyPeerDeps
    },
    auth: {
      githubTokenConfigured: hasValue(env.GITHUB_TOKEN)
    },
    email: {
      enabled: config.email.enabled,
      failOpen: config.email.failOpen,
      recipientConfigured: Boolean(config.email.to),
      senderConfigured: Boolean(config.email.from),
      smtpHost: config.email.host,
      smtpPort: config.email.port,
      smtpSecure: config.email.secure,
      smtpAuthConfigured: Boolean(config.email.user && config.email.pass)
    },
    missingRequiredEnv
  };
}
