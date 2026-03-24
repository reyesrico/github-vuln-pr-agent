export type Severity = "low" | "moderate" | "high" | "critical";

export interface DependabotAlert {
  number: number;
  dependencyName: string;
  dependencyEcosystem: string;
  manifestPath: string;
  severity: Severity;
  summary: string;
  cveId?: string;
  ghsaId: string;
  htmlUrl: string;
  patchedVersion?: string;
}

export interface AlertSignal {
  cveIds: string[];
  ghsaIds: string[];
  dependencyNames: string[];
}

export interface AdvisorySignalPayload {
  repository?: string;
  repositories?: string[];
  cve_ids?: string[];
  ghsa_ids?: string[];
  dependency_names?: string[];
}

export interface RepoCommands {
  install?: string;
  lint?: string;
  test?: string;
}

export interface FixStrategy {
  retryWithLegacyPeerDeps: boolean;
}

export interface FixInput {
  repoFullName: string;
  alert: DependabotAlert;
  branchPrefix: string;
  githubToken: string;
  dryRun: boolean;
  commands: RepoCommands;
  strategy: FixStrategy;
}

export interface BatchFixInput {
  repoFullName: string;
  alerts: DependabotAlert[];
  branchPrefix: string;
  githubToken: string;
  dryRun: boolean;
  commands: RepoCommands;
  strategy: FixStrategy;
}

export interface FixResult {
  repoFullName: string;
  branchName: string;
  changedFiles: string[];
  localPath: string;
  commitMessage: string;
  skipped: boolean;
  reason?: string;
}

export interface CommandResult {
  command: string;
  success: boolean;
  output: string;
}

export interface TestResult {
  repoFullName: string;
  branchName: string;
  commands: CommandResult[];
  success: boolean;
}

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

export interface PullRequestResult {
  repoFullName: string;
  pullNumber: number;
  pullUrl: string;
  title: string;
}

export type FailureCategory =
  | "clone"
  | "install"
  | "test"
  | "validation"
  | "pr"
  | "config"
  | "unknown";

export interface ProcessedAlertResult {
  repoFullName: string;
  alert: DependabotAlert;
  status: "created" | "skipped" | "failed";
  details: string;
  failureCategory?: FailureCategory;
  pullRequest?: PullRequestResult;
}
