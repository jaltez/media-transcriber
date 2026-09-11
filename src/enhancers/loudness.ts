import { execa } from "execa";

/**
 * Loudness utilities for the master enhancement profile: ebur128 measurement
 * and two-pass linear loudnorm, ported from mejora_audio.py loudness_norm() /
 * measure_final(). Two passes matter on heavily compressed tape material: the
 * linear mode reaches the target without extra dynamic processing when the
 * measured values allow it.
 */

export interface LoudnessMeasurement {
  inputI?: number;
  inputTp?: number;
  inputLra?: number;
  inputThresh?: number;
  targetOffset?: number;
}

export interface LoudnessStats {
  lufs?: number;
  truePeakDbtp?: number;
}

export interface LoudnormTargets {
  integratedLufs: number;
  truePeakDbtp: number;
  lra: number;
}

/**
 * Parse the JSON block that `loudnorm=...:print_format=json` prints to stderr.
 * Pure function — exported for tests.
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement | null {
  const braces = stderr.match(/\{[^{}]*\}/g);
  if (!braces) return null;
  for (const block of braces.reverse()) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      const value = (key: string): number | undefined => {
        const raw = parsed[key];
        const num = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : Number.NaN;
        return Number.isFinite(num) ? num : undefined;
      };
      const measurement: LoudnessMeasurement = {
        inputI: value("input_i"),
        inputTp: value("input_tp"),
        inputLra: value("input_lra"),
        inputThresh: value("input_thresh"),
        targetOffset: value("target_offset"),
      };
      if (measurement.inputI !== undefined) return measurement;
    } catch {
      // Try the next brace block.
    }
  }
  return null;
}

/**
 * Parse integrated loudness / true peak from ebur128 summary output. Pure.
 */
export function parseEbur128(stderr: string): LoudnessStats {
  const lufsMatches = [...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)];
  const peakMatches = [...stderr.matchAll(/Peak:\s*(-?[\d.]+)\s*dB(?:TP|FS)/g)];
  return {
    lufs: lufsMatches.length > 0 ? Number.parseFloat(lufsMatches[lufsMatches.length - 1]![1]!) : undefined,
    truePeakDbtp: peakMatches.length > 0 ? Number.parseFloat(peakMatches[peakMatches.length - 1]![1]!) : undefined,
  };
}

/** Measure integrated loudness and true peak of an audio file (ebur128). */
export async function measureLoudness(file: string): Promise<LoudnessStats> {
  const result = await execa(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"],
    { reject: false },
  );
  return parseEbur128(`${result.stdout}\n${result.stderr}`);
}

async function measureLoudnorm(
  file: string,
  targets: LoudnormTargets,
): Promise<LoudnessMeasurement | null> {
  const result = await execa(
    "ffmpeg",
    [
      "-hide_banner",
      "-i", file,
      "-af",
      `loudnorm=I=${targets.integratedLufs}:TP=${targets.truePeakDbtp}:LRA=${targets.lra}:print_format=json`,
      "-f", "null", "-",
    ],
    { reject: false },
  );
  return parseLoudnormJson(`${result.stdout}\n${result.stderr}`);
}

export interface LoudnormApplyResult {
  /** ffmpeg -af argument of the applied (second) pass */
  appliedAf: string;
  /** First-pass measurement, when it completed */
  measurement: LoudnessMeasurement | null;
  /** True when the linear mode was used */
  linear: boolean;
  /** Warning text for the report/progress when falling back to dynamic mode */
  warning?: string;
}

/**
 * Two-pass loudnorm: measure, then apply. Falls back to single-pass dynamic
 * mode when the measurement is incomplete (mirrors mejora_audio.py).
 * `outputArgs` selects the container/codec of the written file.
 */
export async function applyTwoPassLoudnorm(
  inputFile: string,
  outputFile: string,
  targets: LoudnormTargets,
  outputArgs: string[],
): Promise<LoudnormApplyResult> {
  const measurement = await measureLoudnorm(inputFile, targets);
  const base = `loudnorm=I=${targets.integratedLufs}:TP=${targets.truePeakDbtp}:LRA=${targets.lra}`;

  const complete = measurement !== null
    && measurement.inputI !== undefined
    && measurement.inputTp !== undefined
    && measurement.inputLra !== undefined
    && measurement.inputThresh !== undefined
    && measurement.targetOffset !== undefined;

  let appliedAf = base;
  let linear = false;
  let warning: string | undefined;

  if (complete) {
    appliedAf =
      `${base}` +
      `:measured_I=${measurement.inputI}` +
      `:measured_TP=${measurement.inputTp}` +
      `:measured_LRA=${measurement.inputLra}` +
      `:measured_thresh=${measurement.inputThresh}` +
      `:offset=${measurement.targetOffset}` +
      `:linear=true`;
    linear = true;
  } else {
    warning = "loudnorm measurement incomplete; using dynamic mode";
  }

  await execa("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputFile,
    "-af", appliedAf,
    ...outputArgs,
    outputFile,
  ]);

  return { appliedAf, measurement, linear, warning };
}
