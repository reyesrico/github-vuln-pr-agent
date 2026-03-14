const REPO_PATTERN = /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/g;

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
