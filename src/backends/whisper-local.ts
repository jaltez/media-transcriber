import { execa } from "execa";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { TranscriptionBackend, TranscribeOptions } from "./types.js";
import type { Config } from "../config/schema.js";
import type { DependencyStatus, TranscriptSegment } from "../types/index.js";
import {
  discoverLocalWhisper,
  resolveLocalDevice,
  type CommandSpec,
} from "../deps/whisper.js";

/**
 * Local OpenAI Whisper CLI backend.
 * Invokes a discovered local Whisper command.
 */
export class WhisperLocalBackend implements TranscriptionBackend {
  readonly name = "whisper-local";
  readonly displayName = "Whisper (local)";
  readonly defaultModel = "large-v2";

  private config: Config | null = null;
  private commandSpec: CommandSpec | null = null;

  init(config: Config): void {
    this.config = config;
    this.commandSpec = null;
  }

  async checkAvailability(): Promise<DependencyStatus> {
    const result = await discoverLocalWhisper(this.config?.localWhisperCommand);

    if (!result.available) {
      return {
        available: false,
        name: this.name,
        error: result.error ?? "local Whisper not found",
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

    await mkdir(outputDir, { recursive: true });

    const commandSpec = this.commandSpec ?? (await discoverLocalWhisper(this.config?.localWhisperCommand)).commandSpec;
    if (!commandSpec) {
      throw new Error("Local Whisper is not available. Run 'media-transcriber setup whisper-local'.");
    }

    const resolvedDevice = await resolveLocalDevice(commandSpec, device);
    const outputFormat = outputFormats.length === 1 ? outputFormats[0]! : "all";

    const env: Record<string, string> = { ...process.env as Record<string, string>, PYTHONIOENCODING: "utf-8" };
    if (resolvedDevice === "cuda") {
      env["CUDA_VISIBLE_DEVICES"] = "0";
    }

    let result;
    try {
      result = await execa(
        commandSpec.command,
        [
          ...commandSpec.args,
          inputFile,
          "--model", model,
          "--device", resolvedDevice,
          "--output_dir", outputDir,
          "--output_format", outputFormat,
          "--verbose", "False",
        ],
        { env, reject: false },
      );
    } catch (err) {
      throw new Error(`Failed to launch whisper: ${err instanceof Error ? err.message : err}`);
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr ?? "";
      if (stderr.includes("no kernel image is available for execution on the device")) {
        throw new Error(
          "CUDA error: your GPU is not compatible with the installed PyTorch CUDA build. " +
          "Run with '-d cpu' to use CPU instead, or install a PyTorch version matching your GPU's compute capability.",
        );
      }
      throw new Error(`Whisper transcription failed: ${stderr}`);
    }

    // Find output files
    const files = await readdir(outputDir);
    const txtFile = files.find((f) => f.endsWith(".txt"));
    const srtFile = files.find((f) => f.endsWith(".srt"));

    const txtPath = txtFile ? join(outputDir, txtFile) : null;
    const srtPath = srtFile ? join(outputDir, srtFile) : null;
    const wantTxt = outputFormats.includes("txt");

    // Fallback: if TXT is missing/empty but SRT exists, extract text from SRT
    if (wantTxt && srtPath && (!txtPath || (existsSync(txtPath) && (await readFile(txtPath, "utf-8")).trim() === ""))) {
      const srtContent = await readFile(srtPath, "utf-8");
      const textLines: string[] = [];

      for (const line of srtContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^\d+$/.test(trimmed)) continue;
        if (trimmed.includes("-->")) continue;
        textLines.push(trimmed);
      }

      const fallbackTxt = join(outputDir, `${basename(inputFile, extname(inputFile))}.txt`);
      await writeFile(fallbackTxt, textLines.join("\n\n"), "utf-8");

      return {
        txtFile: fallbackTxt,
        srtFile: srtPath,
        partNumber: 0,
      };
    }

    return {
      txtFile: txtPath,
      srtFile: srtPath,
      partNumber: 0,
    };
  }

  supportedModels(): string[] {
    return ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3", "turbo"];
  }

  capabilities() {
    return {};
  }
}
