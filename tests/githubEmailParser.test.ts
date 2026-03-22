import { describe, expect, it } from "vitest";

import {
  extractAlertSignalFromGithubEmail,
  extractRepositoriesFromGithubEmail
} from "../src/parsers/githubEmailParser.js";

describe("extractRepositoriesFromGithubEmail", () => {
  it("extracts unique repository names", () => {
    const raw = `
Affected Repositories
  owner/repo1
package-lock.json
  owner/repo2
package-lock.json
  owner/repo3
`;

    const repos = extractRepositoriesFromGithubEmail(raw);

    expect(repos).toEqual([
      "owner/repo1",
      "owner/repo2",
      "owner/repo3"
    ]);
  });

  it("returns empty list when no repositories exist", () => {
    const repos = extractRepositoriesFromGithubEmail("No repos here");
    expect(repos).toEqual([]);
  });

  it("extracts CVE and dependency signal", () => {
    const raw = `
node-tar Symlink Path Traversal via Drive-Relative Linkpath

High severity

tar

CVE-2026-31802
`;

    const signal = extractAlertSignalFromGithubEmail(raw);
    expect(signal.cveIds).toEqual(["CVE-2026-31802"]);
    expect(signal.ghsaIds).toEqual([]);
    expect(signal.dependencyNames).toEqual(["tar"]);
  });
});
