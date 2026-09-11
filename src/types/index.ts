/**
 * Core types for media-transcriber
 */

/** Supported input file extensions */
export const SUPPORTED_EXTENSIONS = [
  ".m4a",
  ".mp3",
  ".mp4",
  ".mkv",
  ".wav",
  ".flac",
  ".ogg",
  ".webm",
] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

/** Output formats supported by Media Transcriber */
export type OutputFormat = "txt" | "srt";


/** Registry of built-in enhancement engine ids (single source of truth) */
export const ENHANCER_IDS = ["basic", "deepfilternet", "unise"] as const;

export function isEnhancerId(value: string): value is EnhancerId {
  return (ENHANCER_IDS as readonly string[]).includes(value);
}

 /** Audio enhancement engine identifiers */
export type EnhancerId = (typeof ENHANCER_IDS)[number];

/** Post-processing profile applied around the denoise engine */
export type EnhanceProfileId = "asr" | "master";

/** A bandreject notch decided by signal analysis (freq/width in Hz) */
export interface NotchFilter {
  freq: number;
  widthHz: number;
  kind: "hum" | "harmonic" | "howl";
}

/** Transparency report for one enhancement run (see docs/proposals) */
export interface EnhancementReport {
  engine: EnhancerId;
  engineVersion?: string;
  /** External engine invocation, when the engine is a separate process */
  command?: string;
  analysis: {
    humNotches: NotchFilter[];
    howlNotches: NotchFilter[];
  };
  /** ffmpeg filter stages applied, in order */
  filterChain: string;
  profile: EnhanceProfileId;
  /**
   * Where the enhanced audio was written. In the transcribe path this is a
   * temp artifact (last part of N) removed unless keepIntermediateFiles; the
   * standalone enhance command rewrites it to the final output path.
   */
  outputFile: string;
  /** Master profile only */
  loudness?: { beforeLufs?: number | null; afterLufs?: number | null };
  timings: { analysisMs: number; engineMs: number; totalMs: number };
  /** Number of audio parts enhanced (split files yield several) */
  parts: number;
}

/** Device policy for local transcription */
export type DevicePolicy = "auto" | "cuda" | "cpu";

/** A single SRT subtitle entry */
export interface SrtEntry {
  index: number;
  startTime: number; // milliseconds
  endTime: number; // milliseconds
  text: string;
}

/** Result from transcribing a single audio segment */
export interface TranscriptSegment {
  txtFile: string | null;
  srtFile: string | null;
  partNumber: number;
}

/** Result from processing a single input file */
export interface FileResult {
  input: string;
  output: {
    txt: string | null;
    srt: string | null;
  };
  durationSeconds: number;
  backend: string;
  model: string;
  success: boolean;
  error?: string;
  /** Enhancement report, present when an enhancer ran on this file */
  enhancement?: EnhancementReport;
}

/** Summary of the entire batch run */
export interface BatchResult {
  files: FileResult[];
  summary: {
    totalFiles: number;
    successful: number;
    failed: number;
    elapsed: number; // milliseconds
  };
}

/** Dependency availability status */
export interface DependencyStatus {
  available: boolean;
  name: string;
  version?: string;
  error?: string;
  installHint?: string;
  source?: string;
  command?: string;
}

/** Progress event emitted during pipeline execution */
export type ProgressEvent =
  | { event: "batch_start"; totalFiles: number }
  | { event: "file_start"; file: string; fileNumber: number; totalFiles: number }
  | { event: "step_start"; file: string; step: PipelineStep; message?: string }
  | {
      event: "step_progress";
      file: string;
      step: PipelineStep;
      current: number;
      total: number;
      message?: string;
    }
  | { event: "step_complete"; file: string; step: PipelineStep; message?: string }
  | { event: "file_complete"; file: string; success: boolean; error?: string }
  | { event: "batch_complete"; summary: BatchResult["summary"] };

export type PipelineStep =
  | "convert"
  | "check_duration"
  | "split"
  | "enhance"
  | "transcribe"
  | "merge"
  | "copy_output";

/** Exit codes */
export const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  MISSING_DEPENDENCY: 2,
  CONFIG_ERROR: 3,
  NO_INPUT_FILES: 4,
  PARTIAL_SUCCESS: 10,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
