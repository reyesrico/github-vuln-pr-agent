const REPO_PATTERN = /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/g;
const CVE_PATTERN = /\bCVE-\d{4}-\d{4,}\b/g;
const CVE_LINE_PATTERN = /\bCVE-\d{4}-\d{4,}\b/;
const GHSA_PATTERN = /\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/gi;
const WORD_LINE_PATTERN = /^[a-z0-9][a-z0-9._@/+-]*$/i;

export interface ParsedEmailAlertSignal {
  cveIds: string[];
  ghsaIds: string[];
  dependencyNames: string[];
}

export function extractRepositoriesFromGithubEmail(rawEmail: string): string[] {
  const allMatches = rawEmail.match(REPO_PATTERN) ?? [];
  const unique = new Set<string>();

  for (const candidate of allMatches) {
    if (candidate.includes("/")) {
      unique.add(candidate.trim());
    }
  }

  return [...unique];
}

export function extractAlertSignalFromGithubEmail(rawEmail: string): ParsedEmailAlertSignal {
  const cveIds = [...new Set(rawEmail.match(CVE_PATTERN) ?? [])];
  const ghsaIds = [...new Set((rawEmail.match(GHSA_PATTERN) ?? []).map((item) => item.toUpperCase()))];

  const dependencies = new Set<string>();
  const lines = rawEmail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    if (!currentLine || !CVE_LINE_PATTERN.test(currentLine)) {
      continue;
    }

    for (let probe = index - 1; probe >= Math.max(0, index - 4); probe -= 1) {
      const candidate = lines[probe];
      if (!candidate) {
        continue;
      }

      const lower = candidate.toLowerCase();
      if (lower.includes("severity") || lower.includes("affected repositories")) {
        continue;
      }

      if (candidate.includes("/") || candidate.includes(" ")) {
        continue;
      }

      if (WORD_LINE_PATTERN.test(candidate)) {
        dependencies.add(candidate);
        break;
      }
    }
  }

  return {
    cveIds,
    ghsaIds,
    dependencyNames: [...dependencies]
  };
}
