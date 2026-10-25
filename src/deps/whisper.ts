import { execa } from "execa";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { DependencyStatus, DevicePolicy } from "../types/index.js";
import { checkCommand } from "./checker.js";
import { PROBE_CACHE_KEYS, withProbeCache } from "./cache.js";

export const WHISPER_COMMAND_ENV = "MEDIA_TRANSCRIBER_WHISPER_COMMAND";

export type WhisperSource = "override" | "path" | "uv-tool" | "pipx" | "python";

export interface CommandSpec {
  command: string;
  args: string[];
  display: string;
  source: WhisperSource;
  pythonCommand?: string;
  pythonArgs?: string[];
}

export interface LocalWhisperStatus extends DependencyStatus {
  source?: WhisperSource;
  commandSpec?: CommandSpec;
}

const WHISPER_INSTALL_HINT =
  "Run 'media-transcriber setup whisper-local' or install openai-whisper with uv tool, pipx, or pip.";

export function parseCommandLine(commandLine: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (const char of commandLine.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  const [command, ...args] = parts;
  if (!command) {
    throw new Error("Command cannot be empty");
  }

  return { command, args };
}

export async function discoverLocalWhisper(
  overrideCommand = process.env[WHISPER_COMMAND_ENV],
): Promise<LocalWhisperStatus> {
  // Overrides are env-specific and explicit: always probe fresh, never cache.
  if (overrideCommand?.trim()) {
    const parsed = parseCommandLine(overrideCommand);
    const spec: CommandSpec = {
      ...parsed,
      display: overrideCommand,
      source: "override",
    };
    return checkWhisperSpec(spec, true);
  }

  return withProbeCache(
    PROBE_CACHE_KEYS.whisper,
    (status) => status.available === true,
    () => discoverLocalWhisperFromPath(),
  );
}

async function discoverLocalWhisperFromPath(): Promise<LocalWhisperStatus> {
  const pathSpec: CommandSpec = {
    command: "whisper",
    args: [],
    display: "whisper",
    source: "path",
  };
  const pathStatus = await checkWhisperSpec(pathSpec, false);
  if (pathStatus.available) return pathStatus;

  // Candidate discovery is independent per source; run it concurrently and
  // probe in priority order afterwards.
  const [uvSpec, pipxSpec, pythonSpec] = await Promise.all([
    findUvToolWhisper(),
    findPipxWhisper(),
    findPythonWhisper(),
  ]);

  for (const spec of [uvSpec, pipxSpec, pythonSpec]) {
    if (!spec) continue;
    const status = await checkWhisperSpec(spec, false);
    if (status.available) return status;
  }

  return {
    available: false,
    name: "whisper",
    error: "No usable local Whisper installation found",
    installHint: WHISPER_INSTALL_HINT,
  };
}

export async function resolveLocalDevice(
  spec: CommandSpec,
  requested: DevicePolicy,
): Promise<"cuda" | "cpu"> {
  if (requested === "cuda" || requested === "cpu") {
    return requested;
  }

  if (await hasCudaForSpec(spec)) {
    return "cuda";
  }

  return "cpu";
}

/**
 * Returns a process.env copy with PYTHONIOENCODING=utf-8.
 * On Windows, the default console encoding (cp1252) cannot represent
 * some Unicode characters in Whisper's help text (e.g. ideographic period),
 * causing the CLI to crash with UnicodeEncodeError before printing usage info.
 */
function pythonSafeEnv(): Record<string, string> {
  return { ...process.env as Record<string, string>, PYTHONIOENCODING: "utf-8" };
}

async function checkWhisperSpec(
  spec: CommandSpec,
  overrideWasExplicit: boolean,
): Promise<LocalWhisperStatus> {
  try {
    const result = await execa(spec.command, [...spec.args, "--help"], {
      timeout: 15_000,
      reject: false,
      env: pythonSafeEnv(),
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode === 0 || output.toLowerCase().includes("usage:")) {
      return {
        available: true,
        name: "whisper",
        version: await getWhisperVersion(spec),
        source: spec.source,
        command: spec.display,
        commandSpec: spec,
      };
    }
  } catch {
    // Fall through to the unavailable result below.
  }

  return {
    available: false,
    name: "whisper",
    error: overrideWasExplicit
      ? `Whisper command override did not run successfully: ${spec.display}`
      : "Whisper command did not run successfully",
    installHint: overrideWasExplicit
      ? `Fix ${WHISPER_COMMAND_ENV} or --whisper-command, then run 'media-transcriber doctor'.`
      : WHISPER_INSTALL_HINT,
    source: spec.source,
    command: spec.display,
  };
}

async function findUvToolWhisper(): Promise<CommandSpec | null> {
  const uv = await checkCommand("uv");
  if (!uv.available) return null;

  try {
    const result = await execa("uv", ["tool", "list"], {
      timeout: 10_000,
      reject: false,
    });
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (result.exitCode === 0 && output.includes("openai-whisper")) {
      return {
        command: "uv",
        args: ["tool", "run", "--from", "openai-whisper", "whisper"],
        display: "uv tool run --from openai-whisper whisper",
        source: "uv-tool",
      };
    }
  } catch {
    // uv is optional.
  }

  return null;
}

async function findPipxWhisper(): Promise<CommandSpec | null> {
  const pipx = await checkCommand("pipx");
  if (!pipx.available) return null;

  try {
    const result = await execa("pipx", ["list", "--json"], {
      timeout: 10_000,
      reject: false,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;

    const parsed = JSON.parse(result.stdout) as unknown;
    const appPath = findWhisperPath(parsed);
    if (appPath) {
      return {
        command: appPath,
        args: [],
        display: appPath,
        source: "pipx",
      };
    }
  } catch {
    // pipx is optional.
  }

  return null;
}

async function findPythonWhisper(): Promise<CommandSpec | null> {
  const python = await findPythonCommand();
  if (!python) return null;

  try {
    const result = await execa(
      python.command,
      [
        ...python.args,
        "-c",
        'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("whisper") else 1)',
      ],
      { timeout: 10_000, reject: false },
    );
    if (result.exitCode !== 0) return null;
  } catch {
    return null;
  }

  return {
    command: python.command,
    args: [
      ...python.args,
      "-c",
      "from whisper.transcribe import cli; cli()",
    ],
    display: `${python.display} -c "from whisper.transcribe import cli; cli()"`,
    source: "python",
    pythonCommand: python.command,
    pythonArgs: python.args,
  };
}
let pythonCommandMemo: Promise<{
  command: string;
  args: string[];
  display: string;
  executable: string;
} | null> | null = null;

export async function findPythonCommand(): Promise<{
  command: string;
  args: string[];
  display: string;
  /** Resolved executable path (sys.executable); falls back to the command name */
  executable: string;
} | null> {
  // The interpreter choice cannot change mid-process; memoize so repeated
  // probes (device detection, version lookup) don't respawn `python --version`.
  pythonCommandMemo ??= (async () => {
    const candidates = process.platform === "win32"
      ? [
          { command: "python", args: [] as string[], display: "python" },
          { command: "py", args: ["-3"], display: "py -3" },
        ]
      : [{ command: "python3", args: [] as string[], display: "python3" }];

    for (const candidate of candidates) {
      try {
        // A single spawn both validates the interpreter and resolves it:
        // `python3` maps to different executables across venvs/PATH, and
        // sys.executable is what the CUDA cache key needs.
        const resolved = await execa(
          candidate.command,
          [...candidate.args, "-c", "import sys; print(sys.executable)"],
          { timeout: 10_000, reject: false },
        );
        if (typeof resolved.exitCode !== "number" || resolved.exitCode !== 0 || !resolved.stdout.trim()) {
          continue;
        }
        return { ...candidate, executable: resolved.stdout.trim().split("\n")[0]! };
      } catch {
        // Try the next Python command.
      }
    }

    return null;
  })();

  return pythonCommandMemo;
}

// Process-level memo of CUDA probes: batch transcription resolves the device
// for every file, and each probe otherwise costs a full torch import.
const cudaProbes = new Map<string, Promise<boolean>>();

async function hasCudaForSpec(spec: CommandSpec): Promise<boolean> {
  const pythonCommand = spec.pythonCommand
    ? { command: spec.pythonCommand, args: spec.pythonArgs ?? [] }
    : await findPythonCommand();

  if (!pythonCommand) return false;

  // Key on the resolved interpreter executable, not the command name: the
  // same `python3` name resolves to different interpreters across venvs, and
  // a CUDA verdict from one environment must not be served to another.
  const interpreter = await findPythonCommand();
  const cacheKey = `cuda-v1-${interpreter?.executable ?? pythonCommand.command}-${pythonCommand.args.join("-")}`
    .replace(/[^a-zA-Z0-9._-]+/g, "-");

  let probe = cudaProbes.get(cacheKey);
  if (probe === undefined) {
    probe = withProbeCache(
      cacheKey,
      (usable) => usable === true,
      async () => {
        try {
          const result = await execa(
            pythonCommand.command,
            [
              ...pythonCommand.args,
              "-c",
              // torch.cuda.is_available() returns True even when the installed
              // PyTorch CUDA build lacks kernel images for the GPU's compute
              // capability (e.g. RTX 5080 Blackwell / sm_120).  We perform a tiny
              // tensor operation on the GPU to confirm the device is truly usable.
              'import torch;' +
              'assert torch.cuda.is_available(), "CUDA not available";' +
              'torch.zeros(1, device="cuda");' +
              'print("ok")',
            ],
            { timeout: 15_000, reject: false },
          );
          return result.exitCode === 0;
        } catch {
          return false;
        }
      },
    );
    cudaProbes.set(cacheKey, probe);
  }
  return probe;
}

async function getWhisperVersion(spec: CommandSpec): Promise<string | undefined> {
  const pythonCommand = spec.pythonCommand
    ? { command: spec.pythonCommand, args: spec.pythonArgs ?? [] }
    : await findPythonCommand();

  if (!pythonCommand) {
    return `available via ${sourceLabel(spec.source)}`;
  }

  try {
    const result = await execa(
      pythonCommand.command,
      [
        ...pythonCommand.args,
        "-c",
        'import importlib.metadata; print(importlib.metadata.version("openai-whisper"))',
      ],
      { timeout: 10_000, reject: false },
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return `v${result.stdout.trim()} via ${sourceLabel(spec.source)}`;
    }
  } catch {
    // Version is non-critical.
  }

  return `available via ${sourceLabel(spec.source)}`;
}

function sourceLabel(source: WhisperSource): string {
  switch (source) {
    case "override":
      return "override";
    case "path":
      return "PATH";
    case "uv-tool":
      return "uv tool";
    case "pipx":
      return "pipx";
    case "python":
      return "active Python";
  }
}

function findWhisperPath(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = basename(value).toLowerCase().replace(/\.exe$/, "");
    if (normalized === "whisper" && existsSync(value)) {
      return value;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWhisperPath(item);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findWhisperPath(item);
      if (found) return found;
    }
  }

  return null;
}