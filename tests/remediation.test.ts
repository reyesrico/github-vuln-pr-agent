import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FixAgent } from "../src/agents/fixAgent.js";
import { runCommand } from "../src/utils/exec.js";
import type { BatchFixInput } from "../src/types.js";

vi.mock("../src/utils/exec.js", () => ({ runCommand: vi.fn() }));

const temporaryDirectories: string[] = [];
const input: BatchFixInput = {
  repoFullName: "owner/repo",
  alerts: [{
    number: 1, dependencyName: "sprintf-js", dependencyEcosystem: "npm",
    manifestPath: "package-lock.json", severity: "moderate", summary: "test",
    ghsaId: "GHSA-test", htmlUrl: "https://example.invalid/alert"
  }],
  branchPrefix: "chore/security", githubToken: "test", dryRun: false,
  commands: {}, strategy: { retryWithLegacyPeerDeps: true }
};

type CommandOutput = Awaited<ReturnType<typeof runCommand>>;

function output(success: boolean, stdout: string, stderr = ""): CommandOutput {
  return { success, stdout, stderr, output: [stdout, stderr].filter(Boolean).join("\n") };
}

function audit(total: number): CommandOutput {
  return output(total === 0, JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: total ? { "sprintf-js": {} } : {},
    metadata: { vulnerabilities: { total } }
  }));
}

function wrappedAudit(total: number): { audit: unknown } {
  return { audit: JSON.parse(audit(total).stdout) as unknown };
}

function setup(options: {
  auditResult?: CommandOutput;
  removeDependency?: boolean;
  patchedVersion?: string;
  installFails?: boolean;
  recoverAudit?: boolean;
  angular?: boolean;
  cleanInstallFails?: boolean;
} = {}): { repoDir: () => string } {
  let repo = "";
  let auditCalls = 0;
  vi.mocked(runCommand).mockImplementation(async (command, cwd) => {
    if (command.startsWith("git clone ")) {
      temporaryDirectories.push(cwd);
      repo = path.join(cwd, "owner__repo");
      await mkdir(repo);
      await writeFile(path.join(repo, "package.json"), JSON.stringify({ engines: { node: ">=1" } }));
      await writeFile(path.join(repo, ".nvmrc"), "22\n");
      await writeFile(path.join(repo, ".node-version"), "22\n");
      await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({
        packages: { "node_modules/sprintf-js": { version: "1.0.3" } }
      }));
      if (options.angular) {
        await writeFile(path.join(repo, "package.json"), JSON.stringify({
          dependencies: { "@angular/router": "^21.2.24", "@angular/core": "^21.2.8", "@angular/compiler": "^21.2.20" },
          devDependencies: { "@angular/compiler-cli": "^21.2.8", "@angular/cli": "^21.2.26" },
          overrides: { vite: "^7.3.5" }
        }));
        await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({
          packages: {
            "node_modules/@angular/router": { version: "21.2.24" },
            "node_modules/@angular/core": { version: "21.2.24" },
            "node_modules/@angular/compiler": { version: "21.2.20" },
            "node_modules/@angular/compiler-cli": { version: "21.2.17" },
            "node_modules/follow-redirects": { version: "1.16.0" }
          }
        }));
      }
      return output(true, "");
    }
    if (command.startsWith("git checkout -b ")) return output(true, "");
    if (command.startsWith("npm audit fix ")) {
      auditCalls += 1;
      if (options.angular) {
        return auditCalls < 3
          ? output(false, '{"error":{"code":"ERESOLVE"}}', "ERESOLVE incompatible Angular peers")
          : output(false, JSON.stringify(wrappedAudit(1)));
      }
      if (options.removeDependency || options.patchedVersion) {
        await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({
          packages: options.removeDependency ? {} : {
            "node_modules/sprintf-js": { version: options.patchedVersion }
          }
        }));
      }
      if (options.recoverAudit && auditCalls >= 3) return audit(0);
      return options.auditResult ?? audit(1);
    }
    if (command.startsWith("npm install ")) {
      if (options.angular && !options.installFails) {
        const manifestPath = path.join(repo, "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          dependencies: Record<string, string>; devDependencies: Record<string, string>;
        };
        for (const section of [manifest.dependencies, manifest.devDependencies]) {
          for (const name of Object.keys(section)) {
            if (command.includes(`${name}@21.2.25`)) section[name] = "^21.2.25";
          }
        }
        await writeFile(manifestPath, JSON.stringify(manifest));
        await writeFile(path.join(repo, "package-lock.json"), JSON.stringify({
          packages: Object.fromEntries([
            ...Object.keys(manifest.dependencies), "@angular/compiler-cli", "follow-redirects"
          ].map(name => [`node_modules/${name}`, { version: name === "follow-redirects" ? "1.16.1" : "21.2.25" }]))
        }));
      }
      return options.installFails ? output(false, "", "ETARGET missing version") : output(true, "");
    }
    if (command === "npm ci") {
      return options.cleanInstallFails ? output(false, "", "ERESOLVE clean install failed") : output(true, "");
    }
    if (command === "git status --porcelain") return output(true, " M package-lock.json");
    if (command === "git add -A" || command.startsWith("git -c ") || command.startsWith("git push ")) {
      return output(true, "");
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  return { repoDir: () => repo };
}

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("remediation safety", () => {
  it("accepts npm install-style audit envelopes with remaining unrelated findings", async () => {
    setup({ removeDependency: true, auditResult: output(false, JSON.stringify(wrappedAudit(1))) });
    expect((await new FixAgent().applyFixBatch(input)).skipped).toBe(false);
    expect(vi.mocked(runCommand).mock.calls.filter(([command]) => command.startsWith("npm audit fix "))).toHaveLength(1);
  });

  it("rejects operational errors even when accompanied by a valid audit", async () => {
    setup({ removeDependency: true, auditResult: output(false, JSON.stringify({
      error: { code: "ERESOLVE" }, ...wrappedAudit(1)
    })) });
    await expect(new FixAgent().applyFixBatch(input)).rejects.toThrow("Audit remediation failed");
  });

  const angularInput: BatchFixInput = {
    ...input,
    alerts: [
      { ...input.alerts[0]!, dependencyName: "@angular/router", patchedVersion: "21.2.25" },
      { ...input.alerts[0]!, number: 2, dependencyName: "follow-redirects", patchedVersion: "1.16.1" },
      { ...input.alerts[0]!, number: 3, dependencyName: "follow-redirects", patchedVersion: "1.16.1" }
    ]
  };

  it("recovers a mixed Angular batch before transitive overrides and verifies clean installation", async () => {
    const fixture = setup({ angular: true });
    const result = await new FixAgent().applyFixBatch(angularInput);
    expect(result.skipped).toBe(false);
    expect(result.commitMessage).toContain("apply 3 dependency updates");
    const commands = vi.mocked(runCommand).mock.calls.map(([command]) => command);
    const installs = commands.filter(command => command.startsWith("npm install "));
    expect(installs).toEqual([
      "npm install @angular/router@21.2.25 @angular/core@21.2.25 @angular/compiler@21.2.25 @angular/compiler-cli@21.2.25 --package-lock-only --ignore-scripts"
    ]);
    expect(commands.indexOf("npm ci")).toBeGreaterThan(commands.indexOf(installs[0]!));
    expect(commands.indexOf("git add -A")).toBeGreaterThan(commands.indexOf("npm ci"));
    const manifest = JSON.parse(await readFile(path.join(fixture.repoDir(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>; devDependencies: Record<string, string>; overrides: Record<string, string>;
    };
    expect(manifest.dependencies["@angular/router"]).toBe("^21.2.25");
    expect(manifest.devDependencies["@angular/compiler-cli"]).toBe("^21.2.25");
    expect(manifest.devDependencies["@angular/cli"]).toBe("^21.2.26");
    expect(manifest.overrides).toEqual({ vite: "^7.3.5" });
  });

  it.each([
    { angular: true, installFails: true },
    { angular: true, cleanInstallFails: true }
  ])("does not bypass strict Angular install failures: %j", async options => {
    setup(options);
    await expect(new FixAgent().applyFixBatch(angularInput)).rejects.toThrow(/Angular release-group .*failed/);
    const commands = vi.mocked(runCommand).mock.calls.map(([command]) => command);
    expect(commands.some(command => command.startsWith("npm install ") && /--legacy-peer-deps|--force/.test(command))).toBe(false);
    expect(commands.some(command => /git (push|-c )/.test(command))).toBe(false);
  });

  it("does not commit or push unrelated changes for an alert without a patch", async () => {
    setup();
    const result = await new FixAgent().applyFixBatch(input);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("no targeted vulnerability");
    expect(vi.mocked(runCommand).mock.calls.some(([command]) => /git (push|-c )/.test(command))).toBe(false);
  });

  it("allows verified dependency removal without a published patch", async () => {
    setup({ removeDependency: true, auditResult: audit(0) });
    const result = await new FixAgent().applyFixBatch(input);
    expect(result.skipped).toBe(false);
    expect(result.commitMessage).toContain("sprintf-js");
    expect(vi.mocked(runCommand).mock.calls.some(([command]) => command.startsWith("git push "))).toBe(true);
  });

  it("does not treat remaining unrelated advisories as an installation failure", async () => {
    setup({ removeDependency: true, auditResult: audit(1) });
    expect((await new FixAgent().applyFixBatch(input)).skipped).toBe(false);
  });

  it.each([
    ["ETARGET", output(false, '{"error":{"code":"ETARGET"}}', "ETARGET missing version")],
    ["malformed JSON", output(true, "{")],
    ["engine warning", { ...audit(0), stderr: "npm warn EBADENGINE required node >=22" }],
    ["inconsistent failure", { ...audit(0), success: false }]
  ])("blocks %s errors despite file changes and preserves Node policies", async (_name, auditResult) => {
    const fixture = setup({ auditResult, removeDependency: true });
    await expect(new FixAgent().applyFixBatch(input)).rejects.toThrow("Audit remediation failed");
    const manifest = JSON.parse(await readFile(path.join(fixture.repoDir(), "package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(manifest.engines.node).toBe(">=1");
    expect(await readFile(path.join(fixture.repoDir(), ".nvmrc"), "utf8")).toBe("22\n");
    expect(await readFile(path.join(fixture.repoDir(), ".node-version"), "utf8")).toBe("22\n");
    expect(vi.mocked(runCommand).mock.calls.some(([command]) => /git (push|-c )/.test(command))).toBe(false);
  });

  it("allows a final successful retry to recover an operational error", async () => {
    setup({ auditResult: output(false, "", "ETARGET transient"), removeDependency: true, recoverAudit: true });
    expect((await new FixAgent().applyFixBatch(input)).skipped).toBe(false);
  });

  it("propagates failed override installation retries instead of committing the override", async () => {
    setup({ installFails: true });
    const patchedInput: BatchFixInput = {
      ...input, alerts: input.alerts.map(alert => ({ ...alert, patchedVersion: "1.0.4" }))
    };
    await expect(new FixAgent().applyFixBatch(patchedInput)).rejects.toThrow("Retry failed: ETARGET");
    expect(vi.mocked(runCommand).mock.calls.some(([command]) => /git (push|-c )/.test(command))).toBe(false);
  });

  it("propagates failed override installs when legacy retries are disabled", async () => {
    setup({ installFails: true });
    await expect(new FixAgent().applyFixBatch({
      ...input, strategy: { retryWithLegacyPeerDeps: false },
      alerts: input.alerts.map(alert => ({ ...alert, patchedVersion: "1.0.4" }))
    })).rejects.toThrow("Dependency update failed: ETARGET");
  });
});
