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

const PYTHON_CANDIDATES = ["python3", "python", "py"] as const;

function pythonArgs(cmd: string): string[] {
  return cmd === "py" ? ["-3"] : [];
}

/**
 * Find a Python interpreter that has a given module installed.
 * Tries all common interpreter names and returns the first match.
 * Uses importlib.util.find_spec for near-instant detection (no heavy imports).
 */
export async function findPythonWithModule(
  moduleName: string,
): Promise<{ python: DependencyStatus; moduleVersion?: string; resolvedPath?: string }> {
  for (const cmd of PYTHON_CANDIDATES) {
    const prefix = pythonArgs(cmd);
    // First check the interpreter exists
    try {
      await execa(cmd, [...prefix, "--version"], { timeout: 10_000 });
    } catch {
      continue;
    }

    // Check module existence (fast — no torch import)
    try {
      const check = await execa(
        cmd,
        [
          ...prefix,
          "-c",
          `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("${moduleName}") else 1)`,
        ],
        { timeout: 10_000 },
      );
      if (check.exitCode !== 0) continue;
    } catch {
      continue;
    }

    // Get version + interpreter path
    let moduleVersion: string | undefined;
    let resolvedPath: string | undefined;
    try {
      const info = await execa(
        cmd,
        [
          ...prefix,
          "-c",
          `import sys; print(sys.executable); import importlib.metadata; print(importlib.metadata.version("openai-whisper"))`,
        ],
        { timeout: 15_000 },
      );
      const lines = info.stdout.trim().split("\n");
      resolvedPath = lines[0]?.trim();
      moduleVersion = lines[1]?.trim();
    } catch {
      // Non-critical — we still know the module exists
    }

    const versionResult = await execa(cmd, [...prefix, "--version"], { timeout: 10_000 });
    const pyVersion = versionResult.stdout.trim() || versionResult.stderr.trim();

    return {
      python: { available: true, name: cmd, version: pyVersion },
      moduleVersion,
      resolvedPath,
    };
  }

  // No interpreter has the module — report which interpreters were found
  const found: string[] = [];
  for (const cmd of PYTHON_CANDIDATES) {
    try {
      await execa(cmd, [...pythonArgs(cmd), "--version"], { timeout: 10_000 });
      found.push(cmd);
    } catch {
      // not available
    }
  }

  if (found.length === 0) {
    return {
      python: {
        available: false,
        name: "python",
        error: "Python not found in PATH",
        installHint: getInstallHint("python"),
      },
    };
  }

  return {
    python: {
      available: false,
      name: found[0]!,
      error: `'${moduleName}' not found in any Python interpreter (checked: ${found.join(", ")})`,
      installHint:
        `Install via: ${found[0]} -m pip install openai-whisper\n` +
        `    If using a virtualenv, make sure it is activated or set pythonPath in config.`,
    },
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
