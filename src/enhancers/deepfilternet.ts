import { execa } from "execa";
import { z } from "zod";
import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "../config/schema.js";
import type { DependencyStatus } from "../types/index.js";
import { getAudioDuration } from "../pipeline/audio-splitter.js";
import {
  DFN_COMMAND_ENV,
  discoverDeepFilterNet,
  type DfnCommandSpec,
} from "../deps/deepfilternet.js";
import { invalidateProbeCache, PROBE_CACHE_KEYS } from "../deps/cache.js";
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

    // The chain already produced 48 kHz s16 WAV. Only re-encode when the
    // channel layout needs upmixing to stereo; a conformant stereo file is
    // moved as-is (saves a full decode/encode of ~115 MB per 5-min part).
    const conforms = await probeConformant(request.inputFile);
    if (conforms) {
      await rename(request.inputFile, inputPath);
    } else {
      await execa("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", request.inputFile,
        "-vn", "-ar", "48000", "-ac", "2",
        "-c:a", "pcm_s16le",
        inputPath,
      ]);
    }

    const engineArgs = (spec: DfnCommandSpec) => [
      ...spec.args,
      inputPath,
      "-o", workDir,
      ...(spec.variant === "python" ? ["-m", MODEL_NAME] : []),
      ...(spec.variant === "python" && request.attenLimDb !== undefined
        ? ["--atten-lim", String(request.attenLimDb)]
        : []),
    ];

    // deepFilter logs tqdm-style percent lines to stderr on the Python path;
    // forward the latest percentage when present (best effort).
    let lastPercent = 0;
    let result = await execa(spec.command, engineArgs(spec), {
      reject: false,
      timeout: 0,
      all: true,
    });
    if (typeof result.exitCode !== "number") {
      // execa with reject:false resolves spawn failures (ENOENT from a stale
      // cached spec) instead of throwing; a missing exit code means the
      // command never launched. Rediscover once and retry before failing.
      await invalidateProbeCache(PROBE_CACHE_KEYS.deepfilternet);
      const rediscovered = await discoverDeepFilterNet();
      if (!rediscovered.available || !rediscovered.commandSpec) {
        throw new Error(
          `DeepFilterNet is no longer reachable via '${spec.display}'. ${rediscovered.error ?? ""}`.trim(),
        );
      }
      this.commandSpec = rediscovered.commandSpec;
      const retrySpec = rediscovered.commandSpec;
      if (retrySpec.variant === "rust" && request.attenLimDb !== undefined) {
        throw new Error(
          "--dfn-atten requires the Python deepFilter CLI; the Rust deep-filter binary does not support attenuation limits",
        );
      }
      result = await execa(retrySpec.command, engineArgs(retrySpec), {
        reject: false,
        timeout: 0,
        all: true,
      });
    }
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

    const usedSpec = this.commandSpec ?? spec;
    return {
      outputFile,
      engineVersion: usedSpec.variant === "python" ? MODEL_NAME : "deep-filter (Rust)",
      command: `${usedSpec.display} ${engineArgs(usedSpec).slice(usedSpec.args.length).join(" ")}`,
    };
  }
}

const probeStreamSchema = z.object({
  streams: z
    .object({
      sample_rate: z.string().optional(),
      channels: z.number().optional(),
      codec_name: z.string().optional(),
    })
    .array()
    .min(1),
});

/** True when the WAV is already 48 kHz stereo pcm_s16 (no normalize pass needed). */
async function probeConformant(file: string): Promise<boolean> {
  const result = await execa(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,codec_name", "-of", "json", file],
    { reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) return false;
  try {
    const parsed = probeStreamSchema.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) return false;
    const stream = parsed.data.streams[0]!;
    return stream.sample_rate === "48000" && stream.channels === 2 && stream.codec_name === "pcm_s16";
  } catch {
    return false;
  }
}
