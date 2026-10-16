import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function resolveShell(): string | undefined {
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell) {
    return configuredShell;
  }

  return undefined;
}

export async function runCommand(
  command: string,
  cwd: string
): Promise<{ success: boolean; output: string; stdout: string; stderr: string }> {
  try {
    const result = await execAsync(command, {
      cwd,
      shell: resolveShell(),
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n")
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    return {
      success: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n")
    };
  }
}
