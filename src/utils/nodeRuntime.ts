import { readFile } from "node:fs/promises";
import path from "node:path";

export interface NodeRuntime {
  major?: number;
  source: "repo-override" | "package-engines" | "default";
}

function extractNodeMajor(value: string): number | undefined {
  const match = value.match(/\d+/);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

async function readPackageEngineNode(repoDir: string): Promise<string | undefined> {
  const packageJsonPath = path.join(repoDir, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { engines?: { node?: string } };
    return parsed.engines?.node;
  } catch {
    return undefined;
  }
}

export async function resolveNodeRuntime(repoDir: string, nodeVersionOverride?: string): Promise<NodeRuntime> {
  const override = nodeVersionOverride?.trim();
  if (override) {
    const major = extractNodeMajor(override);
    return {
      ...(major ? { major } : {}),
      source: "repo-override"
    };
  }

  const engineNode = await readPackageEngineNode(repoDir);
  if (!engineNode) {
    return { source: "default" };
  }

  const major = extractNodeMajor(engineNode);
  return {
    ...(major ? { major } : {}),
    source: "package-engines"
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function wrapCommandWithNodeRuntime(command: string, runtime: NodeRuntime): string {
  if (!runtime.major) {
    return command;
  }

  // Install the requested Node.js major via npx and run the shell command in that
  // environment. Using --package=node@<N> prepends node@<N>'s bin (node + npm) to
  // PATH so all npm subcommands run against the right runtime.
  return `npx --yes --package=node@${runtime.major} -- sh -c ${shellSingleQuote(command)}`;
}
