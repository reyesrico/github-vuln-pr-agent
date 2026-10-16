import { readFile } from "node:fs/promises";
import path from "node:path";
import { rsort, satisfies, valid, validRange } from "semver";
import { z } from "zod";

import { runCommand } from "./exec.js";

export interface NodeRuntime {
  version?: string;
  source: "repo-override" | "package-engines" | "default";
}

async function readPackageEngineNode(repoDir: string): Promise<string | undefined> {
  const packageJsonPath = path.join(repoDir, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = z.object({
      engines: z.object({ node: z.string().optional() }).optional()
    }).parse(JSON.parse(raw));
    return parsed.engines?.node;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Unable to read Node requirements from ${packageJsonPath}`, { cause: error });
  }
}

export async function resolveNodeRuntime(repoDir: string, nodeVersionOverride?: string): Promise<NodeRuntime> {
  const override = nodeVersionOverride?.trim() || undefined;
  const engineNode = await readPackageEngineNode(repoDir);
  const requirements = [override, engineNode].filter((value): value is string => value !== undefined);
  if (requirements.length === 0) {
    return { source: "default" };
  }

  for (const requirement of requirements) {
    if (!requirement.trim() || !validRange(requirement)) {
      throw new Error(`Invalid Node version requirement: ${JSON.stringify(requirement)}`);
    }
  }

  const source = override ? "repo-override" : "package-engines";
  const matches = (version: string): boolean => requirements.every(range => satisfies(version, range));
  if (matches(process.versions.node)) {
    return { version: process.versions.node, source };
  }

  const result = await runCommand("npm view node versions --json", repoDir);
  if (!result.success) {
    throw new Error(`Unable to resolve an available Node runtime: ${result.output}`);
  }
  const versions = z.array(z.string()).parse(JSON.parse(result.stdout));
  const version = rsort(versions.filter(value => valid(value) && matches(value)))[0];
  if (!version) {
    throw new Error(`No available Node runtime satisfies ${requirements.join(" AND ")}`);
  }
  return { version, source };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function wrapCommandWithNodeRuntime(command: string, runtime: NodeRuntime): string {
  if (!runtime.version || runtime.version === process.versions.node) {
    return command;
  }

  if (!valid(runtime.version)) {
    throw new Error(`Invalid resolved Node version: ${JSON.stringify(runtime.version)}`);
  }
  return `npx --yes --package=node@${runtime.version} -- sh -c ${shellSingleQuote(command)}`;
}
