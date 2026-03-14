import { runCommand } from "../utils/exec.js";
import type { CommandResult, RepoCommands, TestResult } from "../types.js";

export class TestAgent {
  async run(repoFullName: string, branchName: string, localPath: string, commands: RepoCommands): Promise<TestResult> {
    const commandList = [
      commands.lint ?? "npm run lint --if-present",
      commands.test ?? "npm test --if-present"
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
