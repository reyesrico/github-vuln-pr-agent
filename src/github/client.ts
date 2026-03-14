import { Octokit } from "@octokit/rest";

export function createGithubClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

export function splitRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository full name: ${repoFullName}`);
  }
  return { owner, repo };
}
