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
