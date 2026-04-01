import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveNodeRuntime, wrapCommandWithNodeRuntime } from "../src/utils/nodeRuntime.js";

describe("nodeRuntime helpers", () => {
  it("resolves node major from repo override first", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "node-runtime-test-"));
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ engines: { node: ">=16" } }), "utf8");

    const runtime = await resolveNodeRuntime(tmp, "20");
    expect(runtime.major).toBe(20);
    expect(runtime.source).toBe("repo-override");
  });

  it("resolves node major from package engines when no override", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "node-runtime-test-"));
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ engines: { node: ">=20.18.1" } }),
      "utf8"
    );

    const runtime = await resolveNodeRuntime(tmp);
    expect(runtime.major).toBe(20);
    expect(runtime.source).toBe("package-engines");
  });

  it("wraps command with npx node runtime when major is known", () => {
    const wrapped = wrapCommandWithNodeRuntime("npm test -- --watchAll=false", {
      major: 20,
      source: "package-engines"
    });

    expect(wrapped).toContain("npx -y node@20 -c");
    expect(wrapped).toContain("npm test -- --watchAll=false");
  });
});
