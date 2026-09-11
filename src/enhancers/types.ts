import type { Config } from "../config/schema.js";
import type { DependencyStatus, EnhancerId } from "../types/index.js";

export { ENHANCER_IDS, isEnhancerId } from "../types/index.js";

/** Input to one denoise stage (engines only denoise; the chain does the rest). */
export interface DenoiseRequest {
  /** Conditioned WAV produced by the chain (48 kHz pcm_s16le) */
  inputFile: string;
  /** Temp folder the engine may use for intermediates */
  tempFolder: string;
  /** DeepFilterNet attenuation limit in dB, when provided */
  attenLimDb?: number;
  /** Consent for engines that upload audio off-machine */
  allowUpload: boolean;
  onProgress?: (percent: number, message?: string) => void;
}

export interface DenoiseResult {
  /**
   * Denoised WAV. Engines implemented as a pure ffmpeg filter return the input
   * path unchanged and set `filter` instead, so the chain can splice the filter
   * into the next pass.
   */
  outputFile: string;
  filter?: string;
  engineVersion?: string;
  /** External command invoked, recorded verbatim in the enhancement report */
  command?: string;
}

/**
 * Interface that every enhancement engine must implement. Mirrors
 * TranscriptionBackend: registry-driven, doctor-checkable, config-initialized.
 */
export interface AudioEnhancer {
  readonly name: EnhancerId;
  readonly displayName: string;
  /** Experimental engines are labeled as such in help, doctor, and reports */
  readonly experimental?: boolean;
  /** True when the engine sends audio to a remote service */
  readonly requiresUpload: boolean;

  checkAvailability(): Promise<DependencyStatus>;
  init(config: Config): void;
  denoise(request: DenoiseRequest): Promise<DenoiseResult>;
}
