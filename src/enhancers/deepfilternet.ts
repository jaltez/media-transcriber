import { execa } from "execa";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "../config/schema.js";
import type { DependencyStatus } from "../types/index.js";
import { getAudioDuration } from "../pipeline/audio-splitter.js";
import {
  DFN_COMMAND_ENV,
  discoverDeepFilterNet,
  type DfnCommandSpec,
} from "../deps/deepfilternet.js";
import type { AudioEnhancer, DenoiseRequest, DenoiseResult } from "./types.js";

const MODEL_NAME = "DeepFilterNet3";
/** Resampling round-trips can drop a few ms; tolerate a small shortfall. */
const DURATION_TOLERANCE_SECONDS = 0.5;

/**
 * DeepFilterNet 3 engine (MIT, RWTH). Proven on the cassette corpus at
 * ~0.1x realtime on GPU; also runs real-time on CPU. The chain feeds it a
 * 48 kHz s16 WAV; the model weights download to the tool's own cache on
 * first use, which can make the first run noticeably slower.
 */
export class DeepFilterNetEnhancer implements AudioEnhancer {
  readonly name = "deepfilternet" as const;
  readonly displayName = "DeepFilterNet 3";
  readonly requiresUpload = false;

  private commandSpec: DfnCommandSpec | null = null;

  init(_config: Config): void {
    this.commandSpec = null;
  }

  async checkAvailability(): Promise<DependencyStatus> {
    const status = await discoverDeepFilterNet();
    this.commandSpec = status.commandSpec ?? null;
    return {
      available: status.available,
      name: status.name,
      version: status.version,
      error: status.error,
      installHint: status.installHint,
      source: status.source,
      command: status.command,
    };
  }

  async denoise(request: DenoiseRequest): Promise<DenoiseResult> {
    if (!this.commandSpec) {
      await this.checkAvailability();
    }
    const spec = this.commandSpec;
    if (!spec) {
      throw new Error(
        `DeepFilterNet is not available. Install it or set ${DFN_COMMAND_ENV}. ` +
        "Run 'media-transcriber setup deepfilternet' for guided setup.",
      );
    }

    if (spec.variant === "rust" && request.attenLimDb !== undefined) {
      throw new Error(
        "--dfn-atten requires the Python deepFilter CLI; the Rust deep-filter binary does not support attenuation limits",
      );
    }

    const workDir = join(request.tempFolder, "dfn");
    await mkdir(workDir, { recursive: true });
    const inputName = "input.wav";
    const inputPath = join(workDir, inputName);

    // The chain already produced 48 kHz s16 WAV; normalize channel layout and
    // container so both the Python CLI and the Rust binary accept it.
    await execa("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", request.inputFile,
      "-vn", "-ar", "48000", "-ac", "2",
      "-c:a", "pcm_s16le",
      inputPath,
    ]);

    const engineArgs = [
      ...spec.args,
      inputPath,
      "-o", workDir,
      ...(spec.variant === "python" ? ["-m", MODEL_NAME] : []),
      ...(spec.variant === "python" && request.attenLimDb !== undefined
        ? ["--atten-lim", String(request.attenLimDb)]
        : []),
    ];
    const command = `${spec.display} ${engineArgs.slice(spec.args.length).join(" ")}`;

    // deepFilter logs tqdm-style percent lines to stderr on the Python path;
    // forward the latest percentage when present (best effort).
    let lastPercent = 0;
    const result = await execa(spec.command, engineArgs, {
      reject: false,
      timeout: 0,
      all: true,
    });
    const output = result.all ?? "";
    if (result.exitCode !== 0) {
      throw new Error(
        `DeepFilterNet failed (exit ${result.exitCode}): ${output.trim().split("\n").slice(-5).join("\n")}`,
      );
    }
    const percents = [...output.matchAll(/(\d+)%/g)];
    if (percents.length > 0) {
      lastPercent = Number.parseInt(percents[percents.length - 1]![1]!, 10);
    }
    if (lastPercent > 0) request.onProgress?.(lastPercent);

    // The Python CLI writes <stem>_DeepFilterNet3.wav; the Rust binary uses
    // its embedded model's suffix. Resolve whichever new wav appeared.
    const entries = await readdir(workDir);
    const produced = entries.find(
      (name) => name !== inputName && name.startsWith(basename(inputName, ".wav")) && name.endsWith(".wav"),
    );
    if (!produced) {
      throw new Error("DeepFilterNet produced no output file");
    }
    const outputFile = join(workDir, produced);

    const inputDuration = await getAudioDuration(inputPath);
    const outputDuration = await getAudioDuration(outputFile);
    if (inputDuration > 0 && outputDuration < inputDuration - DURATION_TOLERANCE_SECONDS) {
      throw new Error(
        `DeepFilterNet output is shorter than its input (${outputDuration.toFixed(2)}s < ${inputDuration.toFixed(2)}s)`,
      );
    }

    return {
      outputFile,
      engineVersion: spec.variant === "python" ? MODEL_NAME : "deep-filter (Rust)",
      command,
    };
  }
}
