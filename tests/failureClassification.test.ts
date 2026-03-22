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
