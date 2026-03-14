import { describe, expect, it } from "vitest";

import { extractRepositoriesFromGithubEmail } from "../src/parsers/githubEmailParser.js";

describe("extractRepositoriesFromGithubEmail", () => {
  it("extracts unique repository names", () => {
    const raw = `
Affected Repositories
reyesrico/CovidCharts
package-lock.json
reyesrico/workshop-app
package-lock.json
reyesrico/react-test
`;

    const repos = extractRepositoriesFromGithubEmail(raw);

    expect(repos).toEqual([
      "reyesrico/CovidCharts",
      "reyesrico/workshop-app",
      "reyesrico/react-test"
    ]);
  });

  it("returns empty list when no repositories exist", () => {
    const repos = extractRepositoriesFromGithubEmail("No repos here");
    expect(repos).toEqual([]);
  });
});
