import { afterEach, describe, expect, it, vi } from "vitest";

import { listOpenDependabotAlerts } from "../src/github/dependabot.js";
import type { Octokit } from "@octokit/rest";

function createClientThatThrows(status: number, message: string): Octokit {
  return {
    paginate: vi.fn().mockRejectedValue(Object.assign(new Error(message), { status })),
    rest: {
      dependabot: {
        listAlertsForRepo: vi.fn()
      }
    }
  } as unknown as Octokit;
}

describe("listOpenDependabotAlerts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning and returns no alerts when Dependabot alerts are disabled (403)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createClientThatThrows(403, "Dependabot alerts are disabled for this repository");

    const alerts = await listOpenDependabotAlerts(client, "owner/repo", ["high"], 3);

    expect(alerts).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unable to list Dependabot alerts"),
      expect.objectContaining({ repoFullName: "owner/repo", status: 403 })
    );
  });

  it("logs a warning and returns no alerts when access is not permitted (404)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createClientThatThrows(404, "Not Found");

    const alerts = await listOpenDependabotAlerts(client, "owner/repo", ["high"], 3);

    expect(alerts).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unable to list Dependabot alerts"),
      expect.objectContaining({ repoFullName: "owner/repo", status: 404 })
    );
  });

  it("rethrows unexpected errors instead of silently swallowing them", async () => {
    const client = createClientThatThrows(500, "Internal Server Error");

    await expect(listOpenDependabotAlerts(client, "owner/repo", ["high"], 3)).rejects.toThrow(
      "Internal Server Error"
    );
  });
});
