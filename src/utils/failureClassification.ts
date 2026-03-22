import type { FailureCategory } from "../types.js";

export function classifyFailure(message: string): FailureCategory {
  const normalized = message.toLowerCase();

  if (normalized.includes("clone failed")) {
    return "clone";
  }

  if (
    normalized.includes("dependency update failed") ||
    normalized.includes("eresolve") ||
    normalized.includes("peer dependency")
  ) {
    return "install";
  }

  if (normalized.includes("lint") || normalized.includes("test")) {
    return "test";
  }

  if (normalized.includes("validation")) {
    return "validation";
  }

  if (
    normalized.includes("git push failed") ||
    normalized.includes("failed to push some refs") ||
    normalized.includes("fetch first")
  ) {
    return "pr";
  }

  if (normalized.includes("pr") || normalized.includes("pull request")) {
    return "pr";
  }

  if (normalized.includes("email") || normalized.includes("smtp") || normalized.includes("config")) {
    return "config";
  }

  return "unknown";
}
