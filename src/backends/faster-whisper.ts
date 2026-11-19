import { execa } from "execa";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { TranscriptionBackend, TranscribeOptions } from "./types.js";
import type { Config } from "../config/schema.js";
import type { DependencyStatus, TranscriptSegment } from "../types/index.js";
import {
  discoverFasterWhisper,
  type FasterWhisperCommandSpec,
} from "../deps/faster-whisper.js";
import { invalidateProbeCache, PROBE_CACHE_KEYS } from "../deps/cache.js";
import { buildSrtFromSegments, type TimedTextSegment } from "../pipeline/transcript-merger.js";

interface FasterWhisperOutput {
  text?: string;
  segments?: TimedTextSegment[];
  device?: string;
}

/**
 * Local Faster-Whisper backend. Runs Whisper weights through CTranslate2
 * (INT8 on CPU, FP16 on CUDA) via the active Python or a uv-managed
 * environment, then converts the timestamped output to txt/srt itself.
 */
export class FasterWhisperBackend implements TranscriptionBackend {
  readonly name = "faster-whisper";
  readonly displayName = "Faster-Whisper (local, CTranslate2)";
  readonly defaultModel = "turbo";

  private commandSpec: FasterWhisperCommandSpec | null = null;

  init(_config: Config): void {
    this.commandSpec = null;
  }

  async checkAvailability(): Promise<DependencyStatus> {
    const result = await discoverFasterWhisper();

    if (!result.available) {
      return {
        available: false,
        name: this.name,
        error: result.error ?? "faster-whisper not found",
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

    const commandSpec = this.commandSpec ?? (await discoverFasterWhisper()).commandSpec;
    if (!commandSpec) {
      throw new Error(
        "Faster-Whisper is not available. Run 'media-transcriber setup faster-whisper'.",
      );
    }

    await mkdir(outputDir, { recursive: true });

    const stem = basename(inputFile, extname(inputFile));
    const resultPath = join(outputDir, `${stem}.transcription.json`);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PYTHONIOENCODING: "utf-8",
    };
    if (device === "cuda") {
      env["CUDA_VISIBLE_DEVICES"] = "0";
    }

    const launch = (spec: FasterWhisperCommandSpec) =>
      execa(
        spec.command,
        [
          ...spec.args,
          "--model", model,
          "--device", device,
          "--output", resultPath,
          inputFile,
        ],
        { env, reject: false },
      );

    let result = await launch(commandSpec);
    if (typeof result.exitCode !== "number") {
      // execa with reject:false resolves spawn failures (ENOENT from a stale
      // cached spec) instead of throwing; a missing exit code means the
      // command never launched. Rediscover once and retry before failing.
      await invalidateProbeCache(PROBE_CACHE_KEYS.fasterWhisper);
      const rediscovered = await discoverFasterWhisper();
      if (!rediscovered.available || !rediscovered.commandSpec) {
        throw new Error(
          `Faster-Whisper is no longer reachable via '${commandSpec.display}'. ${rediscovered.error ?? ""}`.trim(),
        );
      }
      this.commandSpec = rediscovered.commandSpec;
      result = await launch(rediscovered.commandSpec);
    }

    if (result.exitCode !== 0 || !existsSync(resultPath)) {
      const stderr = (result.stderr ?? "").trim();
      const tail = stderr.length > 800 ? `…${stderr.slice(-800)}` : stderr;
      throw new Error(
        `Faster-Whisper transcription failed (${model}):\n${tail || `exit code ${result.exitCode}`}`,
      );
    }

    let payload: FasterWhisperOutput;
    try {
      payload = JSON.parse(await readFile(resultPath, "utf-8")) as FasterWhisperOutput;
    } finally {
      await rm(resultPath, { force: true });
    }

    const text = (payload.text ?? "").trim();
    const segments = payload.segments ?? [];
    const wantTxt = outputFormats.includes("txt");
    const wantSrt = outputFormats.includes("srt");

    const txtPath = wantTxt && text ? join(outputDir, `${stem}.txt`) : null;
    if (txtPath) {
      await writeFile(txtPath, text + "\n", "utf-8");
    }

    const srtPath = wantSrt && segments.length > 0 ? join(outputDir, `${stem}.srt`) : null;
    if (srtPath) {
      await writeFile(srtPath, buildSrtFromSegments(segments), "utf-8");
    }

    return {
      txtFile: txtPath,
      srtFile: srtPath,
      partNumber: 0,
    };
  }

  supportedModels(): string[] {
    return ["tiny", "base", "small", "medium", "large-v2", "large-v3", "turbo"];
  }

  capabilities() {
    return {};
  }
}
