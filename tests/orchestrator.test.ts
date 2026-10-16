import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Orchestrator } from "../src/agents/orchestrator.js";
import { FixAgent } from "../src/agents/fixAgent.js";
import { TestAgent } from "../src/agents/testAgent.js";
import * as github from "../src/github/dependabot.js";
import { readNotifiedAlertKeys } from "../src/github/notificationState.js";
import type { AppConfig } from "../src/config.js";
import type { DependabotAlert } from "../src/types.js";

vi.mock("../src/github/client.js", () => ({ createGithubClient: vi.fn() }));
vi.mock("../src/github/dependabot.js", () => ({
  createSecurityPullRequest: vi.fn(),
  findOpenSecurityAgentPullRequest: vi.fn(),
  findReusableDependabotPullRequest: vi.fn(),
  findOpenPullRequestByHead: vi.fn(),
  getDefaultBranch: vi.fn(),
  listAccountRepositories: vi.fn(),
  listOpenDependabotAlerts: vi.fn(),
  mergeSecurityPullRequest: vi.fn()
}));
vi.mock("../src/github/notificationState.js", () => ({
  readNotifiedAlertKeys: vi.fn(), writeNotifiedAlertKeys: vi.fn()
}));
vi.mock("../src/notify/emailNotifier.js", () => ({ sendEmailNotification: vi.fn() }));

const config: AppConfig = {
  githubToken: "test", repositories: ["owner/repo"], processOnlyEmailSignal: false,
  dryRun: false, severities: ["moderate"], branchPrefix: "chore/security",
  maxAlertsPerRepo: 3, repoCommands: {}, fixStrategy: { retryWithLegacyPeerDeps: true },
  preflightOnly: false,
  email: { enabled: false, failOpen: true, to: "", from: "", host: "", port: 587, secure: false }
};
const unpatched: DependabotAlert = {
  number: 1, dependencyName: "sprintf-js", dependencyEcosystem: "npm",
  manifestPath: "package-lock.json", severity: "moderate", summary: "test",
  ghsaId: "GHSA-unpatched", htmlUrl: "https://example.invalid/alerts/1"
};
const patched: DependabotAlert = {
  ...unpatched, number: 2, dependencyName: "fixed-package", patchedVersion: "1.0.1",
  ghsaId: "GHSA-patched", htmlUrl: "https://example.invalid/alerts/2"
};
let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-test-"));
  vi.mocked(github.listOpenDependabotAlerts).mockResolvedValue([unpatched, patched]);
  vi.mocked(github.getDefaultBranch).mockResolvedValue("main");
  vi.mocked(readNotifiedAlertKeys).mockResolvedValue(new Set());
  vi.mocked(github.createSecurityPullRequest).mockResolvedValue({
    repoFullName: "owner/repo", pullNumber: 1, pullUrl: "https://example.invalid/pull/1", title: "test"
  });
  vi.spyOn(FixAgent.prototype, "applyFixBatch").mockResolvedValue({
    repoFullName: "owner/repo", branchName: "fix/test", localPath: repoDir,
    changedFiles: ["package-lock.json"], commitMessage: "test", skipped: false
  });
  vi.spyOn(TestAgent.prototype, "run").mockResolvedValue({
    repoFullName: "owner/repo", branchName: "fix/test", commands: [], success: true
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await rm(repoDir, { recursive: true, force: true });
});

async function lock(packages: Record<string, { version: string }>): Promise<void> {
  await writeFile(path.join(repoDir, "package-lock.json"), JSON.stringify({ packages }));
}

describe("orchestrator fix verification", () => {
  it("advertises only verified fixes in a partial-batch PR", async () => {
    await lock({
      "node_modules/sprintf-js": { version: "1.0.3" },
      "node_modules/fixed-package": { version: "1.0.1" }
    });
    const results = await new Orchestrator().run(config);
    expect(results.map(result => result.status)).toEqual(["skipped", "created"]);
    expect(results[0]?.details).toContain("no published patched version");
    const call = vi.mocked(github.createSecurityPullRequest).mock.calls[0];
    expect(call?.[2]).toBe("fix(security): apply 1 dependency updates");
    expect(call?.[3]).toContain("fixed-package");
    expect(call?.[3]).not.toContain("sprintf-js");
  });

  it("does not create or auto-merge a PR when no target is resolved", async () => {
    await lock({
      "node_modules/sprintf-js": { version: "1.0.3" },
      "node_modules/fixed-package": { version: "1.0.0" }
    });
    const results = await new Orchestrator().run(config);
    expect(results.every(result => result.status === "skipped")).toBe(true);
    expect(github.createSecurityPullRequest).not.toHaveBeenCalled();
    expect(github.mergeSecurityPullRequest).not.toHaveBeenCalled();
  });

  it("applies the same verification to dry runs", async () => {
    await lock({
      "node_modules/sprintf-js": { version: "1.0.3" },
      "node_modules/fixed-package": { version: "1.0.1" }
    });
    const results = await new Orchestrator().run({ ...config, dryRun: true });
    expect(results.map(result => result.status)).toEqual(["skipped", "created"]);
    expect(github.createSecurityPullRequest).not.toHaveBeenCalled();
  });

  it("reports verified removal instead of an unknown upgrade", async () => {
    await lock({ "node_modules/fixed-package": { version: "1.0.1" } });
    const results = await new Orchestrator().run(config);
    expect(results.every(result => result.status === "created")).toBe(true);
    expect(vi.mocked(github.createSecurityPullRequest).mock.calls[0]?.[3])
      .toContain("sprintf-js -> removed (no patched release)");
  });

  it("blocks PR creation and auto-merge when verification cannot read the lockfile", async () => {
    const results = await new Orchestrator().run(config);
    expect(results.every(result => result.status === "failed")).toBe(true);
    expect(github.createSecurityPullRequest).not.toHaveBeenCalled();
    expect(github.mergeSecurityPullRequest).not.toHaveBeenCalled();
  });
});
