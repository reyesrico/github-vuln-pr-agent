import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveNodeRuntime, wrapCommandWithNodeRuntime } from "../src/utils/nodeRuntime.js";
import { runCommand } from "../src/utils/exec.js";

vi.mock("../src/utils/exec.js", () => ({ runCommand: vi.fn() }));

const directories: string[] = [];
const current = process.versions.node;
const major = Number(current.split(".")[0]);

async function repository(node?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "node-runtime-test-"));
  directories.push(dir);
  await writeFile(path.join(dir, "package.json"), JSON.stringify(node === undefined ? {} : { engines: { node } }));
  return dir;
}

function registry(versions: string[]): void {
  const stdout = JSON.stringify(versions);
  vi.mocked(runCommand).mockResolvedValue({ success: true, stdout, stderr: "", output: stdout });
}

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("nodeRuntime helpers", () => {
  it("reuses a compatible running runtime rather than installing node@1", async () => {
    expect(await resolveNodeRuntime(await repository(">=1"))).toEqual({
      version: current, source: "package-engines"
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("preserves the default runtime without a requirement", async () => {
    expect(await resolveNodeRuntime(await repository())).toEqual({ source: "default" });
  });

  it("selects an available exact version satisfying the complete range", async () => {
    registry([`${major + 2}.0.0`, `${major + 2}.12.0`, `${major + 2}.13.1`, `${major + 3}.0.0`]);
    const runtime = await resolveNodeRuntime(await repository(`^${major + 2}.13.0`));
    expect(runtime.version).toBe(`${major + 2}.13.1`);
    expect(runCommand).toHaveBeenCalledWith("npm view node versions --json", expect.any(String));
  });

  it("handles upper bounds instead of selecting an excluded major", async () => {
    registry([`${major - 1}.1.0`, current]);
    expect((await resolveNodeRuntime(await repository(`<${major}`))).version).toBe(`${major - 1}.1.0`);
  });

  it("handles disjunctions, prereleases, and minor/patch lower bounds", async () => {
    registry([
      `${major + 2}.12.0`, `${major + 2}.13.1`, `${major + 4}.1.0`,
      `${major + 4}.1.1`, `${major + 5}.0.0-rc.1`, `${major + 5}.0.0`
    ]);
    expect((await resolveNodeRuntime(
      await repository(`^${major + 2}.13.0 || ~${major + 4}.1.0`)
    )).version).toBe(`${major + 4}.1.1`);
  });

  it("honors overrides without violating repository engines", async () => {
    registry([`${major + 2}.1.0`, `${major + 2}.2.0`, `${major + 4}.0.0`]);
    const runtime = await resolveNodeRuntime(await repository(`>=${major + 2}.2.0`), `${major + 2}`);
    expect(runtime).toEqual({ version: `${major + 2}.2.0`, source: "repo-override" });
  });

  it("fails explicitly when override and engines have no common available version", async () => {
    registry([`${major + 2}.0.0`, current]);
    await expect(resolveNodeRuntime(await repository(`>=${major + 2}`), `${major}`))
      .rejects.toThrow("No available Node runtime satisfies");
  });

  it("rejects invalid requirements rather than extracting an arbitrary number", async () => {
    await expect(resolveNodeRuntime(await repository("not-node-22"))).rejects.toThrow("Invalid Node");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("does not silently ignore a malformed manifest", async () => {
    const dir = await repository();
    await writeFile(path.join(dir, "package.json"), "{");
    await expect(resolveNodeRuntime(dir)).rejects.toThrow("Unable to read Node requirements");
  });

  it("reports registry failures and invalid registry data", async () => {
    const dir = await repository(`>=${major + 2}`);
    vi.mocked(runCommand).mockResolvedValue({ success: false, stdout: "", stderr: "offline", output: "offline" });
    await expect(resolveNodeRuntime(dir)).rejects.toThrow("Unable to resolve an available Node runtime");
    vi.mocked(runCommand).mockResolvedValue({ success: true, stdout: "{}", stderr: "", output: "{}" });
    await expect(resolveNodeRuntime(dir)).rejects.toThrow();
  });

  it("wraps commands with the exact verified version and quotes the inner command", () => {
    const wrapped = wrapCommandWithNodeRuntime("npm test -- --name='test'", {
      version: "22.13.1", source: "package-engines"
    });
    expect(wrapped).toContain("npx --yes --package=node@22.13.1");
    expect(wrapped).toContain(`'"'"'`);
  });

  it("avoids npx for the running version and rejects unverified wrapper input", () => {
    expect(wrapCommandWithNodeRuntime("npm test", { version: current, source: "package-engines" }))
      .toBe("npm test");
    expect(() => wrapCommandWithNodeRuntime("npm test", { version: ">=1", source: "package-engines" }))
      .toThrow("Invalid resolved Node version");
  });
});
