import type { Octokit } from "@octokit/rest";

import { splitRepoFullName } from "./client.js";

const NOTIFIED_ALERT_KEYS_VAR = "VULN_AGENT_NOTIFIED_ALERT_KEYS";
const MAX_STORED_KEYS = 2000;

function normalizeKeys(keys: string[]): string[] {
  return [...new Set(keys.filter(Boolean))].slice(-MAX_STORED_KEYS);
}

export async function readNotifiedAlertKeys(
  client: Octokit,
  repoFullName: string
): Promise<Set<string>> {
  const { owner, repo } = splitRepoFullName(repoFullName);

  try {
    const response = await client.request("GET /repos/{owner}/{repo}/actions/variables/{name}", {
      owner,
      repo,
      name: NOTIFIED_ALERT_KEYS_VAR
    });

    const raw = response.data.value;
    const parsed = JSON.parse(raw) as string[];
    return new Set(normalizeKeys(parsed));
  } catch {
    return new Set<string>();
  }
}

export async function writeNotifiedAlertKeys(
  client: Octokit,
  repoFullName: string,
  keys: Set<string>
): Promise<void> {
  const { owner, repo } = splitRepoFullName(repoFullName);
  const value = JSON.stringify(normalizeKeys([...keys]));

  try {
    await client.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
      owner,
      repo,
      name: NOTIFIED_ALERT_KEYS_VAR,
      value
    });
    return;
  } catch {
    // Fall through to create when variable does not exist yet.
  }

  await client.request("POST /repos/{owner}/{repo}/actions/variables", {
    owner,
    repo,
    name: NOTIFIED_ALERT_KEYS_VAR,
    value
  });
}
