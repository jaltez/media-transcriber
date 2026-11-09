import type { ProgressEvent } from "../../types/index.js";

/**
 * Bridge between the TUI and the CLI: build the argv for a child
 * `media-transcriber` process and parse its NDJSON progress stream. The TUI
 * always runs the real CLI (single code path, identical behavior).
 */

export type Device = "auto" | "cuda" | "cpu";
export type DfnAtten = "off" | "6" | "12" | "20";

/** Enhancement tuning shared by both commands (--dfn-atten needs deepfilternet). */
export interface EnhanceTuning {
  declick: boolean;
  humNotch: boolean;
  howlNotch: boolean;
  /** DeepFilterNet attenuation limit in dB; "off" leaves the engine default. */
  dfnAtten: DfnAtten;
}

/** Flags mirroring the CLI defaults: no `--no-hum-notch` until the user opts out. */
export const DEFAULT_ENHANCE_TUNING: EnhanceTuning = {
  declick: false,
  humNotch: true,
  howlNotch: false,
  dfnAtten: "off",
};

function tuningArgs(tuning: EnhanceTuning, enhancer: string): string[] {
  const args: string[] = [];
  if (tuning.declick) args.push("--declick");
  if (!tuning.humNotch) args.push("--no-hum-notch");
  if (tuning.howlNotch) args.push("--howl-notch");
  if (tuning.dfnAtten !== "off" && enhancer === "deepfilternet") {
    args.push("--dfn-atten", tuning.dfnAtten);
  }
  return args;
}

export interface TranscribeForm extends EnhanceTuning {
  backend: string;
  model: string;
  preset: string;
  formats: string;
  outputDir: string;
  device: Device;
  enhancer: "none" | "basic" | "deepfilternet" | "unise";
  enhanceProfile: "asr" | "master";
  allowUpload: boolean;
  splitThreshold: string;
}

export const DEFAULT_TRANSCRIBE_FORM: TranscribeForm = {
  ...DEFAULT_ENHANCE_TUNING,
  backend: "whisper-local",
  model: "",
  preset: "",
  formats: "txt,srt",
  outputDir: "",
  device: "auto",
  enhancer: "none",
  allowUpload: false,
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
  if (form.device !== "auto") args.push("-d", form.device);
  if (form.enhancer !== "none") args.push("--enhance", form.enhancer);
  if (form.enhancer !== "none" && form.enhanceProfile !== "asr") {
    args.push("--enhance-profile", form.enhanceProfile);
  }
  if (form.enhancer !== "none") args.push(...tuningArgs(form, form.enhancer));
  if (form.splitThreshold.trim()) args.push("--split-threshold", form.splitThreshold.trim());
  if (form.allowUpload) args.push("--allow-upload");
  return args;
}

export interface EnhanceForm extends EnhanceTuning {
  enhancer: "basic" | "deepfilternet" | "unise";
  profile: "asr" | "master";
  outputDir: string;
  allowUpload: boolean;
  report: boolean;
}

export const DEFAULT_ENHANCE_FORM: EnhanceForm = {
  ...DEFAULT_ENHANCE_TUNING,
  enhancer: "basic",
  profile: "master",
  outputDir: "",
  allowUpload: false,
  report: true,
};

export function buildEnhanceArgs(form: EnhanceForm, inputFile: string): string[] {
  const args = ["enhance", inputFile, "--json"];
  args.push("--enhancer", form.enhancer);
  args.push("--enhance-profile", form.profile);
  if (form.report) args.push("--report");
  if (form.allowUpload) args.push("--allow-upload");
  args.push(...tuningArgs(form, form.enhancer));
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

export interface RunOutcome {
  success: boolean;
  output?: string;
  reportPath?: string;
  error?: string;
}

/** Path of the <name>_enhancement.json report written next to an enhanced file. */
export function enhancementReportPath(enhancedFile: string): string {
  const dot = enhancedFile.lastIndexOf(".");
  const base = (dot === -1 ? enhancedFile : enhancedFile.slice(0, dot)).replace(/_enhanced$/, "");
  return `${base}_enhancement.json`;
}

/**
 * Interpret the child CLI's final stdout JSON. Success envelopes carry
 * files[]; config failures (e.g. unise without --allow-upload) are a bare
 * { error, message } envelope instead.
 */
export function parseRunOutcome(stdout: string): RunOutcome {
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      error?: string;
      message?: string;
      files?: Array<{
        success: boolean;
        error?: string;
        output?: { txt?: string | null; srt?: string | null };
        enhancement?: { outputFile?: string };
      }>;
    };
    const file = parsed.files?.[0];
    if (!file) {
      if (typeof parsed.error === "string") {
        return { success: false, error: parsed.message ?? parsed.error };
      }
      return { success: false, error: "no result from child" };
    }
    if (!file.success) return { success: false, error: file.error };
    const enhanced = file.enhancement?.outputFile;
    return {
      success: true,
      output: enhanced ?? file.output?.txt ?? file.output?.srt ?? undefined,
      reportPath: enhanced ? enhancementReportPath(enhanced) : undefined,
    };
  } catch {
    return { success: false, error: "unreadable child output" };
  }
}
