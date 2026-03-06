import type { DependencyStatus, TranscriptSegment } from "../types/index.js";
import type { Config } from "../config/schema.js";

/** Options for a single transcription call */
export interface TranscribeOptions {
  inputFile: string;
  model: string;
  device: string;
  outputDir: string;
}

/** Interface that every transcription backend must implement */
export interface TranscriptionBackend {
  /** Unique identifier for this backend */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /** Check if this backend's dependencies are available */
  checkAvailability(): Promise<DependencyStatus>;

  /** Run transcription on an audio file */
  transcribe(options: TranscribeOptions): Promise<TranscriptSegment>;

  /** List of model names this backend supports */
  supportedModels(): string[];

  /** Initialize backend with config (e.g. API keys) */
  init(config: Config): void;
}
