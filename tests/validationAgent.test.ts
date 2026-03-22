import { describe, expect, it } from "vitest";

import { ValidationAgent } from "../src/agents/validationAgent.js";
import type { FixResult, TestResult } from "../src/types.js";

describe("ValidationAgent", () => {
  const validator = new ValidationAgent();

  it("passes when lockfile changed and tests succeeded", () => {
    const fix: FixResult = {
      repoFullName: "owner/repo1",
      branchName: "chore/security/tar/6.2.1",
      changedFiles: ["package-lock.json"],
      localPath: "/tmp/repo",
      commitMessage: "msg",
      skipped: false
    };
    const test: TestResult = {
      repoFullName: "owner/repo1",
      branchName: "chore/security/tar/6.2.1",
      commands: [],
      success: true
    };

    const result = validator.validate(fix, test);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when checks fail", () => {
    const fix: FixResult = {
      repoFullName: "owner/repo1",
      branchName: "chore/security/tar/6.2.1",
      changedFiles: ["README.md"],
      localPath: "/tmp/repo",
      commitMessage: "msg",
      skipped: false
    };
    const test: TestResult = {
      repoFullName: "owner/repo1",
      branchName: "chore/security/tar/6.2.1",
      commands: [],
      success: false
    };

    const result = validator.validate(fix, test);
    expect(result.valid).toBe(false);
    expect(result.reasons.length).toBe(2);
  });
});
