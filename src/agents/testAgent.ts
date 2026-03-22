import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../utils/exec.js";
import type { CommandResult, RepoCommands, TestResult } from "../types.js";

async function loadPackageScripts(localPath: string): Promise<Record<string, string>> {
  const packageJsonPath = path.join(localPath, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function isPlaceholderTestScript(script: string | undefined): boolean {
  if (!script) {
    return false;
  }

  return /no test specified|exit\s+1/i.test(script);
}

export class TestAgent {
  async run(repoFullName: string, branchName: string, localPath: string, commands: RepoCommands): Promise<TestResult> {
    const scripts = await loadPackageScripts(localPath);
    const shouldSkipDefaultTest = !commands.test && isPlaceholderTestScript(scripts.test);

    const commandList = [
      commands.lint ?? "npm run lint --if-present",
      ...(shouldSkipDefaultTest ? [] : [commands.test ?? "npm test --if-present"])
    ];

    const results: CommandResult[] = [];

    for (const command of commandList) {
      const result = await runCommand(command, localPath);
      results.push({ command, success: result.success, output: result.output });
      if (!result.success) {
        return { repoFullName, branchName, commands: results, success: false };
      }
    }

    return { repoFullName, branchName, commands: results, success: true };
  }
}
