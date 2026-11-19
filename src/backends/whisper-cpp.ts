import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { TranscriptionBackend, TranscribeOptions } from "./types.js";
import type { Config } from "../config/schema.js";
import type { DependencyStatus, TranscriptSegment } from "../types/index.js";
import { discoverWhisperCpp, ensureGgmlModel, type WhisperCppCommandSpec } from "../deps/whisper-cpp.js";
import { invalidateProbeCache, PROBE_CACHE_KEYS } from "../deps/cache.js";

const GPU_FAILURE_PATTERN = /cuda|CUDA|ggml_backend/;

/**
 * Local whisper.cpp backend. Runs quantized ggml weights through the
 * whisper-cli binary (no Python), downloading the model once into the cache
 * and converting input to the 16 kHz mono 16-bit WAV that whisper.cpp reads.
 */
export class WhisperCppBackend implements TranscriptionBackend {
  readonly name = "whisper-cpp";
  readonly displayName = "whisper.cpp (local, quantized)";
  readonly defaultModel = "turbo";

  private commandSpec: WhisperCppCommandSpec | null = null;

  init(_config: Config): void {
    this.commandSpec = null;
  }

  async checkAvailability(): Promise<DependencyStatus> {
    const result = await discoverWhisperCpp();

    if (!result.available) {
      return {
        available: false,
        name: this.name,
        error: result.error ?? "whisper.cpp CLI not found",
        installHint: result.installHint,
        source: result.source,
        command: result.command,
      };
    }

    this.commandSpec = result.commandSpec ?? null;

    return {
      available: true,
      name: this.name,
      version: result.version,
      source: result.source,
      command: result.command,
    };
  }

  async transcribe(options: TranscribeOptions): Promise<TranscriptSegment> {
    const { inputFile, model, device, outputDir, outputFormats } = options;

    if (!existsSync(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const commandSpec = this.commandSpec ?? (await discoverWhisperCpp()).commandSpec;
    if (!commandSpec) {
      throw new Error("whisper.cpp is not available. Run 'media-transcriber setup whisper-cpp'.");
    }

    const ggmlModel = await ensureGgmlModel(model);

    await mkdir(outputDir, { recursive: true });

    const stem = basename(inputFile, extname(inputFile));
    const workDir = await mkdtemp(join(tmpdir(), "media-transcriber-whispercpp-"));
    const wavPath = join(workDir, "input.wav");

    try {
      // whisper-cli only accepts 16-bit PCM WAV; everything else must be
      // converted up front (ffmpeg availability is guaranteed by the pipeline).
      const conversion = await execa(
        "ffmpeg",
        ["-nostdin", "-y", "-i", inputFile, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
        { reject: false },
      );
      if (conversion.exitCode !== 0) {
        throw new Error(
          `Failed to convert ${inputFile} to 16 kHz mono WAV:\n${(conversion.stderr ?? "").trim().slice(-800)}`,
        );
      }

      const wantTxt = outputFormats.includes("txt");
      const wantSrt = outputFormats.includes("srt");
      const outputBase = join(outputDir, stem);

      const args = ["-m", ggmlModel, "-f", wavPath, "-l", "auto", "-of", outputBase];
      if (wantTxt) args.push("-otxt");
      if (wantSrt) args.push("-osrt");

      // A CPU-only build needs no flag; an explicit CPU request skips GPU
      // init entirely, which is also the retry path for GPU-less machines.
      const launch = (spec: WhisperCppCommandSpec, noGpu: boolean) =>
        execa(
          spec.command,
          noGpu ? [...args, "-ng"] : args,
          { reject: false },
        );

      let noGpu = device === "cpu";
      let result = await launch(commandSpec, noGpu);

      if (typeof result.exitCode !== "number") {
        // execa with reject:false resolves spawn failures (ENOENT from a stale
        // cached spec) instead of throwing; a missing exit code means the
        // command never launched. Rediscover once and retry before failing.
        await invalidateProbeCache(PROBE_CACHE_KEYS.whisperCpp);
        const rediscovered = await discoverWhisperCpp();
        if (!rediscovered.available || !rediscovered.commandSpec) {
          throw new Error(
            `whisper.cpp is no longer reachable via '${commandSpec.display}'. ${rediscovered.error ?? ""}`.trim(),
          );
        }
        this.commandSpec = rediscovered.commandSpec;
        result = await launch(rediscovered.commandSpec, noGpu);
      }

      if (result.exitCode !== 0 && !noGpu && GPU_FAILURE_PATTERN.test(result.stderr ?? "")) {
        noGpu = true;
        result = await launch(this.commandSpec ?? commandSpec, noGpu);
      }

      if (result.exitCode !== 0) {
        const stderr = (result.stderr ?? "").trim();
        const tail = stderr.length > 800 ? `…${stderr.slice(-800)}` : stderr;
        throw new Error(
          `whisper.cpp transcription failed (${model}):\n${tail || `exit code ${result.exitCode}`}`,
        );
      }

      const txtFile = wantTxt ? `${outputBase}.txt` : null;
      const srtFile = wantSrt ? `${outputBase}.srt` : null;
      for (const path of [txtFile, srtFile]) {
        if (path && !existsSync(path)) {
          throw new Error(`whisper.cpp reported success but did not write ${path}`);
        }
      }

      return { txtFile, srtFile, partNumber: 0 };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  supportedModels(): string[] {
    return ["tiny", "base", "small", "medium", "large-v3", "turbo"];
  }

  capabilities() {
    return {};
  }
}
