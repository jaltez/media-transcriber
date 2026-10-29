import type { ProgressEvent } from "../../types/index.js";

/**
 * Bridge between the TUI and the CLI: build the argv for a child
 * `media-transcriber` process and parse its NDJSON progress stream. The TUI
 * always runs the real CLI (single code path, identical behavior).
 */

export interface TranscribeForm {
  backend: string;
  model: string;
  preset: string;
  formats: string;
  outputDir: string;
  enhancer: "none" | "basic" | "deepfilternet" | "unise";
  enhanceProfile: "asr" | "master";
  splitThreshold: string;
}

export const DEFAULT_TRANSCRIBE_FORM: TranscribeForm = {
  backend: "whisper-local",
  model: "",
  preset: "",
  formats: "txt,srt",
  outputDir: "",
  enhancer: "none",
  enhanceProfile: "asr",
  splitThreshold: "",
};

export function buildTranscribeArgs(form: TranscribeForm, inputFile: string): string[] {
  const args = ["transcribe", inputFile, "--json"];
  if (form.backend) args.push("-b", form.backend);
  if (form.model.trim()) args.push("-m", form.model.trim());
  if (form.preset) args.push("--preset", form.preset);
  if (form.formats.trim()) args.push("-f", form.formats.trim());
  if (form.outputDir.trim()) args.push(form.outputDir.trim());
  if (form.enhancer !== "none") args.push("--enhance", form.enhancer);
  if (form.enhancer !== "none" && form.enhanceProfile !== "asr") {
    args.push("--enhance-profile", form.enhanceProfile);
  }
  if (form.splitThreshold.trim()) args.push("--split-threshold", form.splitThreshold.trim());
  return args;
}

export interface EnhanceForm {
  enhancer: "basic" | "deepfilternet" | "unise";
  profile: "asr" | "master";
  outputDir: string;
  report: boolean;
}

export const DEFAULT_ENHANCE_FORM: EnhanceForm = {
  enhancer: "basic",
  profile: "master",
  outputDir: "",
  report: true,
};

export function buildEnhanceArgs(form: EnhanceForm, inputFile: string): string[] {
  const args = ["enhance", inputFile, "--json"];
  args.push("--enhancer", form.enhancer);
  args.push("--enhance-profile", form.profile);
  if (form.report) args.push("--report");
  if (form.outputDir.trim()) args.push(form.outputDir.trim());
  return args;
}

export function buildDoctorArgs(): string[] {
  return ["doctor", "--all", "--json"];
}

/**
 * Parse one NDJSON line from the child's stderr. Returns the typed
 * ProgressEvent, or null for blank/foreign lines (final result JSON arrives
 * on stdout and is parsed separately).
 */
export function parseProgressLine(line: string): ProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed["event"] !== "string") return null;
    return parsed as unknown as ProgressEvent;
  } catch {
    return null;
  }
}

/** Humanize a progress event into one log line for the TUI run view. */
export function describeProgressEvent(event: ProgressEvent): string | null {
  switch (event.event) {
    case "batch_start":
      return `Batch start: ${event.totalFiles} file(s)`;
    case "file_start":
      return `▶ ${shortName(event.file)} (${event.fileNumber}/${event.totalFiles})`;
    case "step_start":
      return `  · ${event.step}${event.message ? ` — ${event.message}` : ""}`;
    case "step_progress":
      return `  · ${event.step}${event.message ? ` — ${event.message}` : ""}`;
    case "step_complete":
      return null;
    case "file_complete":
      return event.success
        ? `✓ ${shortName(event.file)}`
        : `✗ ${shortName(event.file)}: ${event.error ?? "failed"}`;
    case "batch_complete":
      return `Batch complete: ${event.summary.successful}/${event.summary.totalFiles} succeeded`;
    default:
      return null;
  }
}

function shortName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
