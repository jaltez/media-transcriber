import { execa } from "execa";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { TranscriptionBackend, TranscribeOptions } from "./types.js";
import type { Config } from "../config/schema.js";
import type { DependencyStatus, TranscriptSegment } from "../types/index.js";
import { findPythonWithModule } from "../deps/checker.js";

/**
 * Local OpenAI Whisper CLI backend.
 * Port of lib/whisper_transcriber.py transcribe_audio()
 */
export class WhisperLocalBackend implements TranscriptionBackend {
  readonly name = "whisper-local";
  readonly displayName = "Whisper (local)";

  private pythonCmd = "python3";
  private pythonArgs: string[] = [];

  init(config: Config): void {
    if (config.pythonPath) {
      this.pythonCmd = config.pythonPath;
      this.pythonArgs = [];
    }
  }

  async checkAvailability(): Promise<DependencyStatus> {
    // If user specified pythonPath, only check that interpreter
    if (this.pythonCmd !== "python3") {
      try {
        const check = await execa(
          this.pythonCmd,
          ["-c", 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("whisper") else 1)'],
          { timeout: 10_000 },
        );
        if (check.exitCode === 0) {
          return { available: true, name: this.name, version: `using ${this.pythonCmd}` };
        }
      } catch {
        // fall through
      }
      return {
        available: false,
        name: this.name,
        error: `openai-whisper not found in configured pythonPath (${this.pythonCmd})`,
        installHint: `Install via: ${this.pythonCmd} -m pip install openai-whisper`,
      };
    }

    // Auto-detect: try all Python interpreters for whisper module
    const result = await findPythonWithModule("whisper");

    if (!result.python.available) {
      return {
        available: false,
        name: this.name,
        error: result.python.error ?? "Python or whisper not found",
        installHint: result.python.installHint,
      };
    }

    this.pythonCmd = result.python.name;
    this.pythonArgs = this.pythonCmd === "py" ? ["-3"] : [];

    const versionLabel = result.moduleVersion
      ? `v${result.moduleVersion}`
      : "installed";
    const interpreterLabel = result.resolvedPath ?? this.pythonCmd;

    return {
      available: true,
      name: this.name,
      version: `${versionLabel} (${interpreterLabel})`,
    };
  }

  async transcribe(options: TranscribeOptions): Promise<TranscriptSegment> {
    const { inputFile, model, device, outputDir } = options;

    if (!existsSync(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    await mkdir(outputDir, { recursive: true });

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (device === "cuda") {
      env["CUDA_VISIBLE_DEVICES"] = "0";
    }

    const result = await execa(
      this.pythonCmd,
      [
        ...this.pythonArgs,
        "-m", "whisper",
        inputFile,
        "--model", model,
        "--device", device,
        "--output_dir", outputDir,
        "--output_format", "all",
        "--verbose", "False",
      ],
      { env },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Whisper transcription failed: ${result.stderr}`);
    }

    // Find output files
    const files = await readdir(outputDir);
    const txtFile = files.find((f) => f.endsWith(".txt"));
    const srtFile = files.find((f) => f.endsWith(".srt"));

    const txtPath = txtFile ? join(outputDir, txtFile) : null;
    const srtPath = srtFile ? join(outputDir, srtFile) : null;

    // Fallback: if TXT is missing/empty but SRT exists, extract text from SRT
    if (srtPath && (!txtPath || (existsSync(txtPath) && (await readFile(txtPath, "utf-8")).trim() === ""))) {
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
}
