import type { AdvisorySignalPayload, AlertSignal } from "../types.js";

interface ParsedDispatchSignal {
  repositories: string[];
  alertSignal?: AlertSignal;
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseSignalPayload(rawPayload: string): AdvisorySignalPayload {
  const parsed = JSON.parse(rawPayload) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("ADVISORY_SIGNAL_PAYLOAD must be a JSON object.");
  }

  return parsed as AdvisorySignalPayload;
}

export function parseDispatchSignal(rawPayload?: string): ParsedDispatchSignal {
  if (!rawPayload || !rawPayload.trim()) {
    return { repositories: [] };
  }

  const payload = parseSignalPayload(rawPayload);
  const repository = typeof payload.repository === "string" ? payload.repository.trim() : "";
  const repositories = normalizeStringArray(payload.repositories);

  const uniqueRepositories = new Set<string>();
  if (repository) {
    uniqueRepositories.add(repository);
  }
  for (const repo of repositories) {
    uniqueRepositories.add(repo);
  }

  const cveIds = normalizeStringArray(payload.cve_ids);
  const ghsaIds = normalizeStringArray(payload.ghsa_ids).map((value) => value.toUpperCase());
  const dependencyNames = normalizeStringArray(payload.dependency_names);

  const hasSignal = cveIds.length > 0 || ghsaIds.length > 0 || dependencyNames.length > 0;

  const result: ParsedDispatchSignal = {
    repositories: [...uniqueRepositories]
  };

  if (hasSignal) {
    result.alertSignal = {
      cveIds,
      ghsaIds,
      dependencyNames
    };
  }

  return result;
}