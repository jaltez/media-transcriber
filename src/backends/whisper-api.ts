import { existsSync, statSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { TranscriptionBackend, TranscribeOptions } from "./types.js";
import type { Config } from "../config/schema.js";
import type { DependencyStatus, TranscriptSegment } from "../types/index.js";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB OpenAI limit

/**
 * OpenAI Whisper API backend.
 * Uses the /v1/audio/transcriptions endpoint.
 */
export class WhisperApiBackend implements TranscriptionBackend {
  readonly name = "whisper-api";
  readonly displayName = "Whisper (OpenAI API)";

  private apiKey?: string;

  init(config: Config): void {
    this.apiKey = config.openaiApiKey || process.env["OPENAI_API_KEY"];
  }

  async checkAvailability(): Promise<DependencyStatus> {
    const key = this.apiKey || process.env["OPENAI_API_KEY"];
    if (!key) {
      return {
        available: false,
        name: this.name,
        error: "OpenAI API key not configured",
        installHint:
          "Set OPENAI_API_KEY environment variable or pass --api-key",
      };
    }
    return { available: true, name: this.name, version: "whisper-1" };
  }

  async transcribe(options: TranscribeOptions): Promise<TranscriptSegment> {
    const { inputFile, outputDir } = options;
    const key = this.apiKey || process.env["OPENAI_API_KEY"];

    if (!key) {
      throw new Error(
        "OpenAI API key not configured. Set OPENAI_API_KEY or pass --openai-api-key.",
      );
    }

    if (!existsSync(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }

    const fileSize = statSync(inputFile).size;
    if (fileSize > MAX_FILE_SIZE) {
      throw new Error(
        `File too large for API (${Math.round(fileSize / 1024 / 1024)}MB > 25MB limit). ` +
          `Use splitting or the whisper-local backend.`,
      );
    }

    await mkdir(outputDir, { recursive: true });

    const stem = basename(inputFile, extname(inputFile));

    // Request SRT format
    const srtContent = await this.callApi(key, inputFile, "srt");
    const srtPath = join(outputDir, `${stem}.srt`);
    await writeFile(srtPath, srtContent, "utf-8");

    // Request text format
    const txtContent = await this.callApi(key, inputFile, "text");
    const txtPath = join(outputDir, `${stem}.txt`);
    await writeFile(txtPath, txtContent, "utf-8");

    return {
      txtFile: txtPath,
      srtFile: srtPath,
      partNumber: 0,
    };
  }

  private async callApi(
    apiKey: string,
    filePath: string,
    responseFormat: "srt" | "text" | "json" | "verbose_json" | "vtt",
  ): Promise<string> {
    // Build multipart form data
    const { Blob } = await import("node:buffer");
    const { readFile: readFileFn } = await import("node:fs/promises");

    const fileBuffer = await readFileFn(filePath);
    const fileName = basename(filePath);

    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer]), fileName);
    formData.append("model", "whisper-1");
    formData.append("response_format", responseFormat);

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OpenAI API error (${response.status}): ${errorBody}`,
      );
    }

    return response.text();
  }

  supportedModels(): string[] {
    return ["whisper-1"];
  }
}
