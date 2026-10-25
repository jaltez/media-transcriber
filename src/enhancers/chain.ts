import { execa } from "execa";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  EnhancementReport,
  EnhanceProfileId,
  NotchFilter,
} from "../types/index.js";
import { analyzeAudio, notchesToAf } from "./analysis.js";
import type { AudioEnhancer } from "./types.js";
import { applyTwoPassLoudnorm, measureLoudness } from "./loudness.js";

/**
 * Shared enhancement chain, ported from the cassette restoration pipeline
 * (mejora_audio.py). Every engine gets the same treatment:
 *
 *   [adeclick?] -> highpass=f=70 -> [hum notches]     (conditioning)
 *   -> engine denoise (afftdn | DeepFilterNet3 | UniSE)
 *   -> [howl notches]                                 (opt-in)
 *   -> master only: acompressor -> alimiter -> loudnorm (2-pass)
 *
 * Each stage runs as a separate ffmpeg pass over lossless WAV intermediates
 * (the cassette pipeline did the same), so external engines slot in cleanly.
 * The exact stages are recorded in the report for manual reproduction.
 */

const DYNAMICS_FILTERS = [
  "acompressor=threshold=-25dB:ratio=2.5:attack=10:release=150:makeup=1",
  "alimiter=limit=0.97:attack=5:release=100:level=disabled",
];

export interface EnhanceRunOptions {
  profile: EnhanceProfileId;
  declick: boolean;
  humNotch: boolean;
  howlNotch: boolean;
  loudnessTargetLufs: number;
  /** DeepFilterNet attenuation limit in dB (engine-specific knob) */
  attenLimDb?: number;
  /** Consent for engines that upload audio off-machine */
  allowUpload: boolean;
}

export interface EnhanceRunParams {
  inputFile: string;
  outputFolder: string;
  /** Base name for intermediate/output files (temp folder) */
  baseName: string;
  enhancer: AudioEnhancer;
  options: EnhanceRunOptions;
  /** Container the pipeline expects next: ".mp3" for transcription, ".wav" standalone */
  outputExt: ".mp3" | ".wav";
  onProgress?: (percent: number, message?: string) => void;
}

export async function runEnhancement(
  params: EnhanceRunParams,
): Promise<{ outputFile: string; report: EnhancementReport }> {
  const { inputFile, outputFolder, baseName, enhancer, options, outputExt } = params;
  const onProgress = params.onProgress ?? (() => {});
  const totalStart = Date.now();

  await mkdir(outputFolder, { recursive: true });

  // --- Stage 1: analysis -------------------------------------------------
  const analysisStart = Date.now();
  const runAnalysis = options.humNotch || options.howlNotch;
  const analysis = runAnalysis
    ? await analyzeAudio(inputFile, {
        humNotch: options.humNotch,
        howlNotch: options.howlNotch,
      })
    : { humNotches: [] as NotchFilter[], howlNotches: [] as NotchFilter[] };
  const analysisMs = Date.now() - analysisStart;

  if (analysis.humNotches.length > 0) {
    onProgress(8, `hum notches: ${notchesToAf(analysis.humNotches)}`);
  }
  if (analysis.howlNotches.length > 0) {
    onProgress(8, `howl notches: ${notchesToAf(analysis.howlNotches)}`);
  }

  // --- Stage 2: conditioning ---------------------------------------------
  const conditioning = [
    ...(options.declick ? ["adeclick"] : []),
    "highpass=f=70",
    ...(analysis.humNotches.length > 0 ? [notchesToAf(analysis.humNotches)] : []),
  ];
  const postFilters = [
    ...(analysis.howlNotches.length > 0 ? [notchesToAf(analysis.howlNotches)] : []),
    ...(options.profile === "master" ? DYNAMICS_FILTERS : []),
  ];

  // --- Stages 3+4: engine denoise, then notches/dynamics --------------------
  // Filter-only engines (e.g. the basic afftdn engine) contribute an ffmpeg
  // filter and no output file, so conditioning + denoise + post filters fold
  // into ONE decode/encode pass — three passes and two ~58 MB WAV
  // intermediates per part become one (~20% faster on the default --enhance
  // path). External-process engines keep the staged pipeline so their 48 kHz
  // WAV handoff stays intact.
  const engineStart = Date.now();
  const stages: string[] = [];
  let postFile: string;
  let engineVersion: string | undefined;
  let command: string | undefined;

  if (enhancer.filterOnly === true) {
    const denoised = await enhancer.denoise({
      inputFile,
      tempFolder: outputFolder,
      attenLimDb: options.attenLimDb,
      allowUpload: options.allowUpload,
      onProgress: (percent, message) => onProgress(20 + Math.min(100, percent) * 0.5, message),
    });
    engineVersion = denoised.engineVersion;
    command = denoised.command;
    const foldedFilters = [...conditioning, denoised.filter ?? "", ...postFilters]
      .filter(Boolean)
      .join(",");
    stages.push(foldedFilters);

    const outputFile = join(outputFolder, `${baseName}_enhanced${outputExt}`);
    if (options.profile === "master") {
      // loudnorm needs its own measure+apply passes over processed audio
      postFile = join(outputFolder, `${baseName}_proc.wav`);
      await execa("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", inputFile,
        "-vn",
        "-af", foldedFilters,
        "-ar", "48000",
        "-c:a", "pcm_s16le",
        postFile,
      ]);
    } else {
      // asr: the folded pass IS the final encode — one pass total
      const encodeArgs = outputExt === ".mp3"
        ? ["-c:a", "libmp3lame", "-q:a", "2"]
        : ["-c:a", "pcm_s16le"];
      await execa("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", inputFile,
        "-vn",
        "-af", foldedFilters,
        ...encodeArgs,
        outputFile,
      ]);
      postFile = outputFile;
    }
    onProgress(82, "chain done (single pass)");
  } else {
    const conditionedFile = join(outputFolder, `${baseName}_cond.wav`);
    await execa("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputFile,
      "-vn",
      "-af", conditioning.join(","),
      // 48 kHz stereo WAV: the format DeepFilterNet works at; lossless for others.
      "-ar", "48000",
      "-c:a", "pcm_s16le",
      conditionedFile,
    ]);
    onProgress(15, "conditioning done");

    const denoised = await enhancer.denoise({
      inputFile: conditionedFile,
      tempFolder: outputFolder,
      attenLimDb: options.attenLimDb,
      allowUpload: options.allowUpload,
      onProgress: (percent, message) => onProgress(20 + Math.min(100, percent) * 0.5, message),
    });
    engineVersion = denoised.engineVersion;
    command = denoised.command;
    onProgress(72, "denoise done");

    const appliedPostFilters = [...postFilters];
    if (denoised.filter) {
      appliedPostFilters.unshift(denoised.filter);
    }

    postFile = denoised.outputFile;
    if (appliedPostFilters.length > 0) {
      postFile = join(outputFolder, `${baseName}_post.wav`);
      await execa("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", denoised.outputFile,
        "-vn",
        "-af", appliedPostFilters.join(","),
        "-c:a", "pcm_s16le",
        postFile,
      ]);
    }
    onProgress(82, "post-filters done");

    stages.push(conditioning.join(","));
    stages.push(denoised.command ?? denoised.filter ?? enhancer.displayName);
    if (postFilters.length > 0) stages.push(postFilters.join(","));
  }
  const engineMs = Date.now() - engineStart;

  // --- Stage 5: final encode (+ loudnorm for master) ------------------------
  // In the folded asr case the single pass already produced the final file.
  const finalAlreadyEncoded =
    enhancer.filterOnly === true && options.profile !== "master";
  const outputFile = finalAlreadyEncoded
    ? postFile
    : join(outputFolder, `${baseName}_enhanced${outputExt}`);

  let loudness: EnhancementReport["loudness"];
  if (!finalAlreadyEncoded) {
    if (options.profile === "master") {
      const encodeArgs = outputExt === ".mp3"
        ? ["-c:a", "libmp3lame", "-q:a", "2"]
        : ["-c:a", "pcm_s16le"];
      const loudnorm = await applyTwoPassLoudnorm(
        postFile,
        outputFile,
        { integratedLufs: options.loudnessTargetLufs, truePeakDbtp: -1.5, lra: 11 },
        encodeArgs,
      );
      stages.push(loudnorm.appliedAf);
      if (loudnorm.warning) onProgress(90, loudnorm.warning);
      const after = await measureLoudness(outputFile);
      loudness = {
        beforeLufs: loudnorm.measurement?.inputI ?? null,
        afterLufs: after.lufs ?? null,
      };
    } else {
      const encodeArgs = outputExt === ".mp3"
        ? ["-c:a", "libmp3lame", "-q:a", "2"]
        : ["-c:a", "pcm_s16le"];
      await execa("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", postFile,
        "-vn",
        ...encodeArgs,
        outputFile,
      ]);
    }
  }
  onProgress(96, "encode done");

  const report: EnhancementReport = {
    engine: enhancer.name,
    engineVersion,
    command,
    analysis: {
      humNotches: analysis.humNotches,
      howlNotches: analysis.howlNotches,
    },
    filterChain: stages.join(" | "),
    profile: options.profile,
    ...(loudness ? { loudness } : {}),
    timings: {
      analysisMs,
      engineMs,
      totalMs: Date.now() - totalStart,
    },
    parts: 1,
    outputFile,
  };

  onProgress(100);
  return { outputFile, report };
}

/**
 * Merge per-part reports into one file-level report. Analysis and engine
 * metadata come from the first part; timings are summed.
 */
export function mergeEnhancementReports(
  reports: EnhancementReport[],
  outputFile: string,
): EnhancementReport | undefined {
  if (reports.length === 0) return undefined;
  const first = reports[0]!;
  if (reports.length === 1) return { ...first, outputFile };

  return {
    ...first,
    timings: reports.reduce(
      (acc, r) => ({
        analysisMs: acc.analysisMs + r.timings.analysisMs,
        engineMs: acc.engineMs + r.timings.engineMs,
        totalMs: acc.totalMs + r.timings.totalMs,
      }),
      { analysisMs: 0, engineMs: 0, totalMs: 0 },
    ),
    parts: reports.length,
    outputFile,
  };
}
