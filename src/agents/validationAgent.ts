import type { FixResult, TestResult, ValidationResult } from "../types.js";

function hasRelevantManifestFile(changedFiles: string[]): boolean {
  return changedFiles.some((file) => file === "package-lock.json" || file === "package.json");
}

export class ValidationAgent {
  validate(fixResult: FixResult, testResult: TestResult): ValidationResult {
    const reasons: string[] = [];

    if (fixResult.skipped) {
      reasons.push(fixResult.reason ?? "Fix step was skipped");
    }

    if (!hasRelevantManifestFile(fixResult.changedFiles)) {
      reasons.push("No package.json or package-lock.json changes detected");
    }

    if (!testResult.success) {
      reasons.push("Lint/test checks failed");
    }

    return {
      valid: reasons.length === 0,
      reasons
    };
  }
}
