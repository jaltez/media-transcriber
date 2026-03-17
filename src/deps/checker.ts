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

/** Check if uv is available */
export async function checkUv(): Promise<DependencyStatus> {
  try {
    const result = await execa("uv", ["--version"], { timeout: 10_000 });
    const version = result.stdout.trim();
    return { available: true, name: "uv", version };
  } catch {
    return {
      available: false,
      name: "uv",
      error: "uv not found in PATH",
      installHint: getInstallHint("uv"),
    };
  }
}

/**
 * Check if uv is available and the whisper module is installed
 * in the uv-managed environment.
 */
export async function checkUvWhisper(): Promise<DependencyStatus> {
  const uvStatus = await checkUv();
  if (!uvStatus.available) return uvStatus;

  // Check that whisper module is reachable via uv run
  try {
    const check = await execa(
      "uv",
      ["run", "python", "-c", 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("whisper") else 1)'],
      { timeout: 15_000 },
    );
    if (check.exitCode !== 0) {
      return {
        available: false,
        name: "whisper",
        error: "openai-whisper not found in uv environment",
        installHint: "Install via: uv add openai-whisper",
      };
    }
  } catch {
    return {
      available: false,
      name: "whisper",
      error: "openai-whisper not found in uv environment",
      installHint: "Install via: uv add openai-whisper",
    };
  }

  // Get version info
  let moduleVersion: string | undefined;
  try {
    const info = await execa(
      "uv",
      ["run", "python", "-c", 'import importlib.metadata; print(importlib.metadata.version("openai-whisper"))'],
      { timeout: 15_000 },
    );
    moduleVersion = info.stdout.trim();
  } catch {
    // Non-critical
  }

  const versionLabel = moduleVersion ? `v${moduleVersion}` : "installed";
  return {
    available: true,
    name: "whisper",
    version: `${versionLabel} (via uv)`,
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
