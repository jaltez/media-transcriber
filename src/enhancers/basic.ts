import type { Config } from "../config/schema.js";
import type { DependencyStatus } from "../types/index.js";
import { checkFfmpeg } from "../deps/ffmpeg.js";
import type { AudioEnhancer, DenoiseRequest, DenoiseResult } from "./types.js";

const INSTALL_HINT = "FFmpeg is required. Run 'media-transcriber setup whisper-local' for guided FFmpeg installation.";

/**
 * Zero-dependency enhancement engine built on ffmpeg's afftdn spectral denoiser.
 * The rest of the chain (highpass, notches, dynamics) is shared across engines
 * and applied by chain.ts; this engine contributes only the denoise filter.
 * afftdn=nr=12 matches the cassette pipeline's no-AI fallback (--sin-ia).
 */
export class BasicEnhancer implements AudioEnhancer {
  readonly name = "basic" as const;
  readonly displayName = "FFmpeg (built-in)";
  readonly requiresUpload = false;

  init(_config: Config): void {
    // No configuration needed.
  }

  async checkAvailability(): Promise<DependencyStatus> {
    const ffmpegStatus = await checkFfmpeg();
    return {
      available: ffmpegStatus.ffmpeg.available,
      name: this.name,
      version: ffmpegStatus.ffmpeg.version,
      error: ffmpegStatus.ffmpeg.available ? undefined : (ffmpegStatus.ffmpeg.error ?? "ffmpeg is not available"),
      installHint: ffmpegStatus.ffmpeg.available ? undefined : INSTALL_HINT,
    };
  }

  async denoise(request: DenoiseRequest): Promise<DenoiseResult> {
    return {
      outputFile: request.inputFile,
      filter: "afftdn=nr=12",
    };
  }
}
