import { execa } from "execa";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { checkCommand } from "./checker.js";
import { parseCommandLine, findPythonCommand } from "./whisper.js";

export const DFN_COMMAND_ENV = "MEDIA_TRANSCRIBER_DFN_COMMAND";

export type DfnSource =
  | "override"
  | "path"
  | "uv-tool"
  | "pipx"
  | "python"
  | "rust-binary";

export interface DfnCommandSpec {
  command: string;
  args: string[];
  display: string;
  source: DfnSource;
  /** "python" = deepFilter console script or df.enhance module (full CLI). */
  variant: "python" | "rust";
}

export interface DeepFilterNetStatus {
  available: boolean;
  name: string;
  version?: string;
  error?: string;
  installHint?: string;
  source?: DfnSource;
  command?: string;
  commandSpec?: DfnCommandSpec;
}

const DFN_INSTALL_HINT =
  "Run 'media-transcriber setup deepfilternet' or install deepfilternet with uv tool, pipx, or pip.";

/**
 * deepfilternet 0.5.6 imports torchaudio.backend.common.AudioMetaData, which
 * was removed in torchaudio 2.9 — every deepFilter CLI invocation fails with
 * ModuleNotFoundError until torchaudio is pinned below 2.9. Detected during the
 * cassette restoration work (mejora_audio.py carries a runtime shim for the
 * Python API; for CLI use the pin is the only fix).
 */
function isTorchaudioBreakage(stderr: string): boolean {
  return (
    stderr.includes("torchaudio.backend") ||
    (stderr.includes("ModuleNotFoundError") && stderr.includes("torchaudio"))
  );
}

const TORCHAUDIO_HINT =
  "deepfilternet 0.5.6 is incompatible with torchaudio >= 2.9. Reinstall with torchaudio pinned: " +
  "uv tool install deepfilternet --with torch --with \"torchaudio<2.9\" " +
  "(or run 'media-transcriber setup deepfilternet').";

async function checkDfnSpec(
  spec: DfnCommandSpec,
  overrideWasExplicit: boolean,
): Promise<DeepFilterNetStatus> {
  const versionFlag = spec.variant === "rust" ? ["-V"] : ["--version"];
  try {
    const result = await execa(spec.command, [...spec.args, ...versionFlag], {
      // The --version probe imports df, which imports torch; on slow
      // filesystems (observed 37 s on a WSL-mounted Windows drive) that
      // exceeds typical probe timeouts.
      timeout: 90_000,
      reject: false,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode === 0 && output.trim().length > 0) {
      return {
        available: true,
        name: "deepfilternet",
        version: output.split("\n")[0]?.trim(),
        source: spec.source,
        command: spec.display,
        commandSpec: spec,
      };
    }
    if (isTorchaudioBreakage(output)) {
      return {
        available: false,
        name: "deepfilternet",
        error: "deepfilternet is installed but broken: torchaudio >= 2.9 removed a module it imports",
        installHint: TORCHAUDIO_HINT,
        source: spec.source,
        command: spec.display,
      };
    }
  } catch {
    // Fall through to the unavailable result below.
  }

  return {
    available: false,
    name: "deepfilternet",
    error: overrideWasExplicit
      ? `DeepFilterNet command override did not run successfully: ${spec.display}`
      : "DeepFilterNet command did not run successfully",
    installHint: overrideWasExplicit
      ? `Fix ${DFN_COMMAND_ENV} or run 'media-transcriber doctor --enhancer deepfilternet'.`
      : DFN_INSTALL_HINT,
    source: spec.source,
    command: spec.display,
  };
}

async function findUvToolDfn(): Promise<DfnCommandSpec | null> {
  const uv = await checkCommand("uv");
  if (!uv.available) return null;

  try {
    const result = await execa("uv", ["tool", "list"], {
      timeout: 10_000,
      reject: false,
    });
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (result.exitCode === 0 && output.includes("deepfilternet")) {
      return {
        command: "uv",
        args: ["tool", "run", "--from", "deepfilternet", "deepFilter"],
        display: "uv tool run --from deepfilternet deepFilter",
        source: "uv-tool",
        variant: "python",
      };
    }
  } catch {
    // uv is optional.
  }

  return null;
}

async function findPipxDfn(): Promise<DfnCommandSpec | null> {
  const pipx = await checkCommand("pipx");
  if (!pipx.available) return null;

  try {
    const result = await execa("pipx", ["list", "--json"], {
      timeout: 10_000,
      reject: false,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    const appPath = findDfnAppPath(JSON.parse(result.stdout) as unknown);
    if (appPath) {
      return {
        command: appPath,
        args: [],
        display: appPath,
        source: "pipx",
        variant: "python",
      };
    }
  } catch {
    // pipx is optional.
  }

  return null;
}

async function findPythonDfn(): Promise<DfnCommandSpec | null> {
  const python = await findPythonCommand();
  if (!python) return null;

  try {
    const result = await execa(
      python.command,
      [
        ...python.args,
        "-c",
        'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("df") else 1)',
      ],
      { timeout: 10_000, reject: false },
    );
    if (result.exitCode !== 0) return null;
  } catch {
    return null;
  }

  return {
    command: python.command,
    args: [...python.args, "-m", "df.enhance"],
    display: `${python.display} -m df.enhance`,
    source: "python",
    variant: "python",
  };
}

/**
 * Discover a usable DeepFilterNet CLI. Order mirrors local Whisper discovery:
 * env override -> PATH -> uv tool -> pipx -> active Python -> Rust binary.
 * The Rust `deep-filter` binary is accepted last: it embeds DeepFilterNet2
 * (not 3) and lacks --atten-lim, but needs no Python at all.
 */
export async function discoverDeepFilterNet(
  overrideCommand = process.env[DFN_COMMAND_ENV],
): Promise<DeepFilterNetStatus> {
  if (overrideCommand?.trim()) {
    const parsed = parseCommandLine(overrideCommand);
    const variant = /deep-filter(?!net)/.test(parsed.command) ? "rust" : "python";
    return checkDfnSpec(
      { ...parsed, display: overrideCommand, source: "override", variant },
      true,
    );
  }

  const pathSpec: DfnCommandSpec = {
    command: "deepFilter",
    args: [],
    display: "deepFilter",
    source: "path",
    variant: "python",
  };
  const pathStatus = await checkDfnSpec(pathSpec, false);
  if (pathStatus.available) return pathStatus;

  const candidates: Array<Promise<DfnCommandSpec | null>> = [
    findUvToolDfn(),
    findPipxDfn(),
    findPythonDfn(),
  ];
  for (const candidate of await Promise.all(candidates)) {
    if (!candidate) continue;
    const status = await checkDfnSpec(candidate, false);
    if (status.available) return status;
  }

  const rustSpec: DfnCommandSpec = {
    command: "deep-filter",
    args: [],
    display: "deep-filter",
    source: "rust-binary",
    variant: "rust",
  };
  const rustStatus = await checkDfnSpec(rustSpec, false);
  if (rustStatus.available) return rustStatus;

  return {
    available: false,
    name: "deepfilternet",
    error: "No usable DeepFilterNet installation found",
    installHint: DFN_INSTALL_HINT,
  };
}

function findDfnAppPath(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = basename(value).toLowerCase().replace(/\.exe$/, "");
    if ((normalized === "deepfilter" || normalized === "deep-filter") && existsSync(value)) {
      return value;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDfnAppPath(item);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = findDfnAppPath(item);
      if (found) return found;
    }
  }

  return null;
}
