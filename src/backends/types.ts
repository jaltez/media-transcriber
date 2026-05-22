import type {
  DependencyStatus,
  DevicePolicy,
  OutputFormat,
  TranscriptSegment,
} from "../types/index.js";
import type { Config } from "../config/schema.js";

export interface BackendCapabilities {
  maxInputBytes?: number;
}

/** Options for a single transcription call */
export interface TranscribeOptions {
  inputFile: string;
  model: string;
  device: DevicePolicy;
  outputDir: string;
  outputFormats: OutputFormat[];
}

/** Interface that every transcription backend must implement */
export interface TranscriptionBackend {
  /** Unique identifier for this backend */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /** Default model for this backend */
  readonly defaultModel: string;

  /** Check if this backend's dependencies are available */
  checkAvailability(): Promise<DependencyStatus>;

  /** Run transcription on an audio file */
  transcribe(options: TranscribeOptions): Promise<TranscriptSegment>;

  /** List of model names this backend supports */
  supportedModels(): string[];

  /** Backend limits that affect preprocessing */
  capabilities(): BackendCapabilities;

  /** Initialize backend with config (e.g. API keys) */
  init(config: Config): void;
}

export function validateBackendModel(
  backend: TranscriptionBackend,
  model: string,
): string | null {
  const supported = backend.supportedModels();
  if (supported.includes(model)) {
    return null;
  }

  return `Model '${model}' is not supported by ${backend.displayName}. Supported models: ${supported.join(", ")}`;
}
