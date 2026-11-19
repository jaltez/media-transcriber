import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { TranscriptionBackend, TranscribeOptions } from "./types.js";
import type { Config } from "../config/schema.js";
import type { DependencyStatus, TranscriptSegment } from "../types/index.js";
import type { SpeechLmCommandSpec, SpeechLmStatus } from "../deps/speech-lm.js";
import { invalidateProbeCache } from "../deps/cache.js";
import { buildSrtFromSegments, type TimedTextSegment } from "../pipeline/transcript-merger.js";

interface SpeechLmOutput {
  text?: string;
  segments?: TimedTextSegment[];
  device?: string;
}

/**
 * Shared runtime for text-only transformers speech-LM backends (Granite,
 * Voxtral): both run the same embedded script and produce one cue per audio
 * chunk, so only discovery and model metadata differ.
 */
export abstract class SpeechLmBackend implements TranscriptionBackend {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly defaultModel: string;
  /** Probe-cache key invalidated when the runtime disappears mid-run */
  protected abstract readonly cacheKey: string;
  /** Message shown when the runtime cannot be discovered at transcription time */
  protected abstract readonly unavailableMessage: string;

  abstract supportedModels(): string[];

  protected abstract discover(): Promise<SpeechLmStatus>;

  private commandSpec: SpeechLmCommandSpec | null = null;

  init(_config: Config): void {
    this.commandSpec = null;
  }

  async checkAvailability(): Promise<DependencyStatus> {
    const result = await this.discover();

    if (!result.available) {
      return {
        available: false,
        name: this.name,
        error: result.error ?? `${this.displayName} runtime not found`,
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

    const commandSpec = this.commandSpec ?? (await this.discover()).commandSpec;
    if (!commandSpec) {
      throw new Error(this.unavailableMessage);
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

    const launch = (spec: SpeechLmCommandSpec) =>
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
      await invalidateProbeCache(this.cacheKey);
      const rediscovered = await this.discover();
      if (!rediscovered.available || !rediscovered.commandSpec) {
        throw new Error(
          `${this.displayName} is no longer reachable via '${commandSpec.display}'. ${rediscovered.error ?? ""}`.trim(),
        );
      }
      this.commandSpec = rediscovered.commandSpec;
      result = await launch(rediscovered.commandSpec);
    }

    if (result.exitCode !== 0 || !existsSync(resultPath)) {
      const stderr = (result.stderr ?? "").trim();
      const tail = stderr.length > 800 ? `…${stderr.slice(-800)}` : stderr;
      throw new Error(
        `${this.displayName} transcription failed (${model}):\n${tail || `exit code ${result.exitCode}`}`,
      );
    }

    let payload: SpeechLmOutput;
    try {
      payload = JSON.parse(await readFile(resultPath, "utf-8")) as SpeechLmOutput;
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

  capabilities() {
    return {};
  }
}
