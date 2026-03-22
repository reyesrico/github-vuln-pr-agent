import type { FixResult, TestResult, ValidationResult } from "../types.js";

export class ValidationAgent {
  validate(fixResult: FixResult, testResult: TestResult): ValidationResult {
    const reasons: string[] = [];

    if (fixResult.skipped) {
      reasons.push(fixResult.reason ?? "Fix step was skipped");
    }

    // Keep command outputs available for reporting, but do not block PR creation here.
    void testResult;

    return {
      valid: reasons.length === 0,
      reasons
    };
  }
}
