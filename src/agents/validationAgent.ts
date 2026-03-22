import type { FixResult, TestResult, ValidationResult } from "../types.js";

function hasRelevantManifestFile(changedFiles: string[]): boolean {
  const relevantNames = new Set([
    "package-lock.json",
    "package.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json"
  ]);

  return changedFiles.some(
    (file) => relevantNames.has(file) || [...relevantNames].some((name) => file.endsWith(`/${name}`))
  );
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
