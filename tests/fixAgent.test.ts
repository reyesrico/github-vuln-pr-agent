import { describe, expect, it } from "vitest";

import {
  createOverrideConflictFallbackCommand,
  isGitRefNamespaceConflict,
  isNpmOverrideConflict
} from "../src/agents/fixAgent.js";

describe("fixAgent helpers", () => {
  it("detects git ref namespace conflicts", () => {
    const output =
      "cannot lock ref 'refs/heads/chore/security/pkg/1.2.3/alert-1/x': 'refs/heads/chore/security/pkg/1.2.3' exists; cannot create";

    expect(isGitRefNamespaceConflict(output)).toBe(true);
  });

  it("detects npm override conflicts", () => {
    const output = "npm error code EOVERRIDE npm error Override for undici@7.24.0 conflicts with direct dependency";

    expect(isNpmOverrideConflict(output)).toBe(true);
  });

  it("creates fallback install command when package-lock-only is present", () => {
    const command = "npm install undici@7.24.0 --package-lock-only";

    expect(createOverrideConflictFallbackCommand(command)).toBe(
      "npm install undici@7.24.0 --save-exact"
    );
  });

  it("does not create fallback command for non npm install commands", () => {
    const command = "npm ci --package-lock-only";

    expect(createOverrideConflictFallbackCommand(command)).toBeUndefined();
  });
});
