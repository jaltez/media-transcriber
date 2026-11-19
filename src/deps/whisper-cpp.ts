import { execa } from "execa";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DependencyStatus } from "../types/index.js";
import { cacheDirPath, PROBE_CACHE_KEYS, withProbeCache } from "./cache.js";

export const WHISPERCPP_COMMAND_ENV = "MEDIA_TRANSCRIBER_WHISPERCPP_COMMAND";

export interface WhisperCppCommandSpec {
  command: string;
  display: string;
}

export interface WhisperCppStatus extends DependencyStatus {
  commandSpec?: WhisperCppCommandSpec;
}

export const WHISPERCPP_INSTALL_HINT =
  "Install whisper.cpp (e.g. 'brew install whisper-cpp' on macOS, " +
  "'conda install -c conda-forge whispercpp', or build from source: " +
  "https://github.com/ggml-org/whisper.cpp) or set " +
  `${WHISPERCPP_COMMAND_ENV}.`;

/**
 * Model id -> ggml file in ggerganov/whisper.cpp on Hugging Face. Large
 * variants pin q5_0 quantization: the leanest useful weights (turbo is
 * ~574 MB) with no measurable WER loss for transcription.
 */
const GGML_MODELS: Record<string, string> = {
  tiny: "ggml-tiny.bin",
  base: "ggml-base.bin",
  small: "ggml-small.bin",
  medium: "ggml-medium.bin",
  "large-v3": "ggml-large-v3-q5_0.bin",
  turbo: "ggml-large-v3-turbo-q5_0.bin",
};

const GGML_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

const PATH_CANDIDATES = ["whisper-cli", "whisper-main"];

async function probeCommand(command: string, args: string[] = []): Promise<boolean> {
  try {
    const result = await execa(command, [...args, "--help"], {
      timeout: 10_000,
      reject: false,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function discoverWhisperCppFresh(override?: string): Promise<WhisperCppStatus> {
  if (override) {
    if (await probeCommand(override)) {
      return {
        available: true,
        name: "whisper-cpp",
        version: "custom command",
        command: override,
        source: "override",
        commandSpec: { command: override, display: override },
      };
    }
    return {
      available: false,
      name: "whisper-cpp",
      error: `${WHISPERCPP_COMMAND_ENV} is set to '${override}' but it did not run successfully`,
      installHint: WHISPERCPP_INSTALL_HINT,
      command: override,
    };
  }

  for (const candidate of PATH_CANDIDATES) {
    if (await probeCommand(candidate)) {
      return {
        available: true,
        name: "whisper-cpp",
        version: "whisper.cpp CLI",
        command: candidate,
        source: "path",
        commandSpec: { command: candidate, display: candidate },
      };
    }
  }

  return {
    available: false,
    name: "whisper-cpp",
    error: "whisper.cpp CLI (whisper-cli) not found",
    installHint: WHISPERCPP_INSTALL_HINT,
  };
}

/**
 * Discover a whisper.cpp CLI. Order: MEDIA_TRANSCRIBER_WHISPERCPP_COMMAND
 * override -> PATH (whisper-cli, then the older whisper-main name).
 */
export async function discoverWhisperCpp(
  override = process.env[WHISPERCPP_COMMAND_ENV],
): Promise<WhisperCppStatus> {
  return withProbeCache(
    PROBE_CACHE_KEYS.whisperCpp,
    (status) => status.available === true,
    () => discoverWhisperCppFresh(override),
  );
}

/**
 * Resolve the ggml weights for a model, downloading them into the cache on
 * first use. Downloads land in a `.part` file and are renamed only after the
 * body completes, so an interrupted download never looks like a valid model.
 */
export async function ensureGgmlModel(model: string): Promise<string> {
  const file = GGML_MODELS[model];
  if (!file) {
    throw new Error(
      `Model '${model}' is not available for whisper-cpp. Supported models: ${Object.keys(GGML_MODELS).join(", ")}`,
    );
  }

  const dir = join(cacheDirPath(), "whisper.cpp");
  const target = join(dir, file);
  await mkdir(dir, { recursive: true });

  // A completed download is renamed atomically and never disappears, so a
  // plain stat check is enough to detect a cached model.
  try {
    await stat(target);
    return target;
  } catch {
    // Not cached yet.
  }

  const url = `${GGML_BASE_URL}/${file}`;
  const partPath = `${target}.part`;
  process.stderr.write(`Downloading ${file} from huggingface.co…\n`);

  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partPath));
    await rename(partPath, target);
  } catch (error) {
    await unlink(partPath).catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to download whisper.cpp model from ${url}: ${detail}`);
  }

  return target;
}
