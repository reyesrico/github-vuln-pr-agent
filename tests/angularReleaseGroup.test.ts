import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { planAngularReleaseGroupUpdate } from "../src/agents/angularReleaseGroup.js";
import type { DependabotAlert } from "../src/types.js";

const directories: string[] = [];
const alert: DependabotAlert = {
  number: 1, dependencyName: "@angular/router", patchedVersion: "21.2.25",
  dependencyEcosystem: "npm", manifestPath: "package-lock.json", severity: "high",
  summary: "Router advisory", ghsaId: "GHSA-test", htmlUrl: "https://example.invalid/alert"
};

async function fixture(options: {
  installed?: string;
  declared?: string;
  missing?: boolean;
  transitive?: boolean;
} = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "angular-release-test-"));
  directories.push(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    dependencies: {
      "@angular/common": "^21.2.8",
      "@angular/core": "^21.2.8",
      "@angular/compiler": "^21.2.20",
      ...(!options.transitive ? { "@angular/router": options.declared ?? "^21.2.24" } : {})
    },
    devDependencies: {
      "@angular/compiler-cli": "~21.2.8", "@angular/cli": "^21.2.26",
      "@angular-devkit/build-angular": "^21.2.7", "@angular/material": "^21.2.9"
    },
    overrides: { vite: "^7.3.5" }
  }));
  await writeFile(path.join(directory, "package-lock.json"), JSON.stringify({
    packages: {
      "node_modules/@angular/common": { version: options.installed ?? "21.2.24" },
      "node_modules/@angular/core": { version: "21.2.24" },
      "node_modules/@angular/compiler": { version: "21.2.20" },
      "node_modules/@angular/compiler-cli": options.missing ? {} : { version: "21.2.17" },
      "node_modules/@angular/router": { version: "21.2.24" }
    }
  }));
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("Angular release-group planning", () => {
  it("coordinates framework/compiler patches without aligning independent tooling or editing files", async () => {
    const directory = await fixture();
    const before = await readFile(path.join(directory, "package.json"), "utf8");
    expect(await planAngularReleaseGroupUpdate(directory, [alert])).toEqual([
      "@angular/common@21.2.25", "@angular/core@21.2.25", "@angular/compiler@21.2.25",
      "@angular/router@21.2.25", "@angular/compiler-cli@21.2.25"
    ]);
    expect(await readFile(path.join(directory, "package.json"), "utf8")).toBe(before);
  });

  it("never downgrades a newer installed framework patch", async () => {
    const directory = await fixture({ installed: "21.2.28" });
    expect((await planAngularReleaseGroupUpdate(directory, [alert])).every(spec => spec.endsWith("@21.2.28"))).toBe(true);
  });

  it("never lowers a newer declared minimum when the lockfile is stale", async () => {
    const directory = await fixture({ declared: "^21.2.30" });
    expect((await planAngularReleaseGroupUpdate(directory, [alert])).every(spec => spec.endsWith("@21.2.30"))).toBe(true);
  });

  it("uses the highest required patch across multiple alerts", async () => {
    const directory = await fixture();
    const specs = await planAngularReleaseGroupUpdate(directory, [
      alert, { ...alert, dependencyName: "@angular/core", patchedVersion: "21.2.29" }
    ]);
    expect(specs.every(spec => spec.endsWith("@21.2.29"))).toBe(true);
  });

  it.each(["22.2.1", "21.3.1", "21.2.26-rc.0", "invalid"])(
    "blocks incompatible or unstable installed versions: %s", async installed => {
      await expect(planAngularReleaseGroupUpdate(await fixture({ installed }), [alert])).rejects.toThrow("manual review");
    }
  );

  it.each(["22.0.1", "21.3.1", "21.2.26-rc.0", "invalid"])(
    "blocks incompatible or unstable patch targets: %s", async patchedVersion => {
      await expect(planAngularReleaseGroupUpdate(await fixture(), [{ ...alert, patchedVersion }])).rejects.toThrow("manual review");
    }
  );

  it("rejects missing locked versions and complex repository version policies", async () => {
    await expect(planAngularReleaseGroupUpdate(await fixture({ missing: true }), [alert])).rejects.toThrow("manual review");
    await expect(planAngularReleaseGroupUpdate(await fixture({ declared: "workspace:*" }), [alert])).rejects.toThrow("manual review");
  });

  it("does not turn transitive alerts into direct dependencies", async () => {
    expect(await planAngularReleaseGroupUpdate(await fixture({ transitive: true }), [alert])).toEqual([]);
  });

  it("does not read manifests for unrelated alerts or alerts without a patch", async () => {
    const noPatch = { ...alert };
    delete noPatch.patchedVersion;
    expect(await planAngularReleaseGroupUpdate("/does-not-exist", [
      { ...alert, dependencyName: "follow-redirects" }, noPatch
    ])).toEqual([]);
  });
});
