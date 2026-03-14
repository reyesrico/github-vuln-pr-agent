import dotenv from "dotenv";
import { z } from "zod";

import { extractRepositoriesFromGithubEmail } from "./parsers/githubEmailParser.js";
import type { RepoCommands, Severity } from "./types.js";

dotenv.config({ quiet: true });

const schema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  ALERT_REPOSITORIES: z.string().optional(),
  RAW_GITHUB_EMAIL: z.string().optional(),
  DRY_RUN: z.string().default("true"),
  VULN_SEVERITIES: z.string().default("critical,high,moderate"),
  BRANCH_PREFIX: z.string().default("chore/security"),
  MAX_ALERTS_PER_REPO: z.string().default("3"),
  REPO_COMMANDS: z.string().default("{}"),
  PREFLIGHT_ONLY: z.string().default("false"),
  EMAIL_ENABLED: z.string().default("true"),
  EMAIL_TO: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().default("smtp-mail.outlook.com"),
  SMTP_PORT: z.string().default("587"),
  SMTP_SECURE: z.string().default("false"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional()
});

function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseRepoCommands(raw: string): Record<string, RepoCommands> {
  try {
    const parsed = JSON.parse(raw) as Record<string, RepoCommands>;
    return parsed;
  } catch {
    return {};
  }
}

function parseOptionalEmail(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const validated = z.string().email().safeParse(trimmed);
  if (!validated.success) {
    throw new Error(`Invalid email address: ${trimmed}`);
  }

  return trimmed;
}

function parseRepositories(raw: z.infer<typeof schema>): string[] {
  const configured = raw.ALERT_REPOSITORIES ? parseCsv(raw.ALERT_REPOSITORIES) : [];
  const fromEmail = raw.RAW_GITHUB_EMAIL
    ? extractRepositoriesFromGithubEmail(raw.RAW_GITHUB_EMAIL)
    : [];
  const merged = new Set([...configured, ...fromEmail]);
  return [...merged];
}

export interface AppConfig {
  githubToken: string;
  repositories: string[];
  dryRun: boolean;
  severities: Severity[];
  branchPrefix: string;
  maxAlertsPerRepo: number;
  repoCommands: Record<string, RepoCommands>;
  preflightOnly: boolean;
  email: {
    enabled: boolean;
    to: string;
    from: string;
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
  };
}

export function loadConfig(): AppConfig {
  const parsed = schema.parse(process.env);
  const repositories = parseRepositories(parsed);

  if (repositories.length === 0) {
    throw new Error("No repositories detected. Set ALERT_REPOSITORIES or RAW_GITHUB_EMAIL.");
  }

  const emailEnabled = parseBoolean(parsed.EMAIL_ENABLED);
  const emailTo = parseOptionalEmail(parsed.EMAIL_TO);
  const emailFrom = parseOptionalEmail(parsed.EMAIL_FROM);

  if (emailEnabled && (!emailTo || !emailFrom)) {
    throw new Error("EMAIL_TO and EMAIL_FROM are required when EMAIL_ENABLED=true.");
  }

  if (emailEnabled && (!parsed.SMTP_USER || !parsed.SMTP_PASS)) {
    throw new Error("SMTP_USER and SMTP_PASS are required when EMAIL_ENABLED=true.");
  }

  const emailConfig: AppConfig["email"] = {
    enabled: emailEnabled,
    to: emailTo ?? "",
    from: emailFrom ?? "",
    host: parsed.SMTP_HOST,
    port: Number(parsed.SMTP_PORT),
    secure: parseBoolean(parsed.SMTP_SECURE)
  };

  if (parsed.SMTP_USER) {
    emailConfig.user = parsed.SMTP_USER;
  }

  if (parsed.SMTP_PASS) {
    emailConfig.pass = parsed.SMTP_PASS;
  }

  return {
    githubToken: parsed.GITHUB_TOKEN,
    repositories,
    dryRun: parseBoolean(parsed.DRY_RUN),
    severities: parseCsv(parsed.VULN_SEVERITIES) as Severity[],
    branchPrefix: parsed.BRANCH_PREFIX,
    maxAlertsPerRepo: Number(parsed.MAX_ALERTS_PER_REPO),
    repoCommands: parseRepoCommands(parsed.REPO_COMMANDS),
    preflightOnly: parseBoolean(parsed.PREFLIGHT_ONLY),
    email: emailConfig
  };
}
