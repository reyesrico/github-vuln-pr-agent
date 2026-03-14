import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function runCommand(
  command: string,
  cwd: string
): Promise<{ success: boolean; output: string }> {
  try {
    const result = await execAsync(command, {
      cwd,
      shell: "/bin/zsh",
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      success: true,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n")
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    return {
      success: false,
      output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n")
    };
  }
}
