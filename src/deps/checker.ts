import { execa } from "execa";
import type { DependencyStatus } from "../types/index.js";

/**
 * Check if a CLI tool is available by running `<command> <versionFlag>`.
 * Returns availability status with version info.
 */
export async function checkCommand(
  command: string,
  versionFlag = "--version",
): Promise<DependencyStatus> {
  try {
    const result = await execa(command, [versionFlag], { timeout: 10_000 });
    const version = result.stdout.split("\n")[0]?.trim();
    return { available: true, name: command, version };
  } catch {
    return {
      available: false,
      name: command,
      error: `'${command}' not found in PATH`,
      installHint: getInstallHint(command),
    };
  }
}

/** Check if Python is available and return its path */
export async function findPython(): Promise<DependencyStatus> {
  // Try common Python names in order of preference
  for (const cmd of ["python3", "python", "py"]) {
    try {
      const args = cmd === "py" ? ["-3", "--version"] : ["--version"];
      const result = await execa(cmd, args, { timeout: 10_000 });
      const version = result.stdout.trim() || result.stderr.trim();
      return { available: true, name: cmd, version };
    } catch {
      // continue
    }
  }

  return {
    available: false,
    name: "python",
    error: "Python not found in PATH",
    installHint: getInstallHint("python"),
  };
}

function getInstallHint(command: string): string {
  const platform = process.platform;
  const hints: Record<string, Record<string, string>> = {
    ffmpeg: {
      win32: "Install via: winget install ffmpeg  OR  scoop install ffmpeg",
      darwin: "Install via: brew install ffmpeg",
      linux: "Install via: sudo apt install ffmpeg  OR  sudo dnf install ffmpeg",
    },
    ffprobe: {
      win32: "Included with ffmpeg. Install via: winget install ffmpeg",
      darwin: "Included with ffmpeg. Install via: brew install ffmpeg",
      linux:
        "Included with ffmpeg. Install via: sudo apt install ffmpeg",
    },
    python: {
      win32: "Install via: winget install Python.Python.3  OR  https://python.org",
      darwin: "Install via: brew install python3",
      linux: "Install via: sudo apt install python3",
    },
  };

  return (
    hints[command]?.[platform] ??
    `Install '${command}' and ensure it is available in your PATH.`
  );
}
