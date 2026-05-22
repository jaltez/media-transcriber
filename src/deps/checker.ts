import { execa } from "execa";
import type { DependencyStatus } from "../types/index.js";

/**
 * Check if a CLI tool is available by running `<command> <versionFlag>`.
 * Returns availability status with version info.
 */
export async function checkCommand(
  command: string,
  versionFlag: string | string[] = "--version",
): Promise<DependencyStatus> {
  const args = Array.isArray(versionFlag) ? versionFlag : [versionFlag];
  try {
    const result = await execa(command, args, { timeout: 10_000 });
    const output = result.stdout || result.stderr;
    const version = output.split("\n")[0]?.trim();
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

export function getInstallHint(command: string): string {
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
    uv: {
      win32: "Install via: powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\"",
      darwin: "Install via: curl -LsSf https://astral.sh/uv/install.sh | sh",
      linux: "Install via: curl -LsSf https://astral.sh/uv/install.sh | sh",
    },
  };

  return (
    hints[command]?.[platform] ??
    `Install '${command}' and ensure it is available in your PATH.`
  );
}
