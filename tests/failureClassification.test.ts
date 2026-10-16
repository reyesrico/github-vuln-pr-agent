import { describe, expect, it } from "vitest";

import { classifyFailure } from "../src/utils/failureClassification.js";

describe("classifyFailure", () => {
  it("classifies clone failures", () => {
    expect(classifyFailure("Clone failed for owner/repo")).toBe("clone");
  });

  it("classifies install conflicts", () => {
    expect(classifyFailure("Dependency update failed: npm error ERESOLVE could not resolve")).toBe(
      "install"
    );
  });

  it.each([
    "Audit remediation failed; manual review required",
    "Audit fix failed after retry: ETARGET",
    "No available Node runtime satisfies >=22 AND 20",
    "Invalid Node version requirement: not-node-22"
  ])("classifies remediation failures: %s", message => {
    expect(classifyFailure(message)).toBe("install");
  });

  it("classifies force upgrade requirements as breaking-upgrade", () => {
    expect(
      classifyFailure(
        "Command failed: npm audit fix --package-lock-only. fix available via `npm audit fix --force` Will install webpack@5.105.4, which is a breaking change"
      )
    ).toBe("breaking-upgrade");
  });

  it("classifies test failures", () => {
    expect(classifyFailure("Test failed: npm run test exited 1")).toBe("test");
  });

  it("classifies git push conflicts as pr failures", () => {
    expect(
      classifyFailure("Git push failed: [rejected] chore/security/x -> chore/security/x (fetch first)")
    ).toBe("pr");
  });

  it("classifies unknown failures", () => {
    expect(classifyFailure("Some unexpected runtime failure")).toBe("unknown");
  });
});
