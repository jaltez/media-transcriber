import { execa } from "execa";
import type { NotchFilter } from "../types/index.js";
import { welchPsd } from "../deps/analysis-fft.js";

/**
 * Signal analysis for the enhancement stage: mains-hum and howl detection via
 * Welch PSD. Ported from mejora_audio.py (cassette restoration pipeline), where
 * the heuristics were validated on 11 digitized tapes: detected hum landed at
 * 48.4 Hz / 59.2 Hz (tape-speed flutter off the 50/60 Hz nominal), which a
 * hardcoded notch would have missed.
 *
 * Detection runs on 16 kHz mono — plenty for a hum band under ~1 kHz and the
 * howl band under 7 kHz, and cheap to decode.
 */

export const ANALYSIS_SAMPLE_RATE = 16000;

/** Hum is stationary; the first minutes are representative (mejora: 300 s). */
export const HUM_ANALYSIS_SECONDS = 300;
/** Howl analysis window cap (enhancement runs post-split, so parts are short). */
export const HOWL_ANALYSIS_SECONDS = 1200;
export const HOWL_BLOCK_SECONDS = 10;
const HOWL_MIN_BLOCKS = 10;
const HUM_RATIO = 3.0;
const HOWL_MARGIN_DB = 12.0;
const HOWL_MIN_BLOCK_FRACTION = 0.7;
/** Howl band upper limit. mejora used <8 kHz at 44.1 kHz SR; at 16 kHz SR we
 * stay below Nyquist to avoid resampler edge content. */
const HOWL_MAX_FREQ = 7000;

export interface AudioAnalysis {
  humNotches: NotchFilter[];
  howlNotches: NotchFilter[];
}

/**
 * Decode up to `maxSeconds` of mono f32le PCM from any media file.
 */
export async function decodeMono(
  inputFile: string,
  maxSeconds: number,
  sampleRate = ANALYSIS_SAMPLE_RATE,
): Promise<Float32Array> {
  const result = await execa(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputFile,
      "-vn",
      "-ac", "1",
      "-ar", String(sampleRate),
      "-t", String(maxSeconds),
      "-f", "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  const bytes = result.stdout;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const usable = bytes.byteLength - (bytes.byteLength % 4);
  const samples = new Float32Array(usable / 4);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getFloat32(i * 4, true);
  }
  return samples;
}

/**
 * Run hum/howl analysis on a media file. Each detection is independent and
 * capped in duration, so cost stays bounded for long inputs.
 */
export async function analyzeAudio(
  inputFile: string,
  options: { humNotch?: boolean; howlNotch?: boolean } = {},
): Promise<AudioAnalysis> {
  const humNotches: NotchFilter[] = [];
  const howlNotches: NotchFilter[] = [];

  if (options.humNotch !== false) {
    const samples = await decodeMono(inputFile, HUM_ANALYSIS_SECONDS);
    humNotches.push(...detectHumFromSamples(samples, ANALYSIS_SAMPLE_RATE));
  }

  if (options.howlNotch === true) {
    const samples = await decodeMono(inputFile, HOWL_ANALYSIS_SECONDS);
    howlNotches.push(...detectHowlFromSamples(samples, ANALYSIS_SAMPLE_RATE));
  }

  return { humNotches, howlNotches };
}

/**
 * Mains hum detection (port of mejora_audio.py detect_hum): the strongest bin
 * near 50/60 Hz that exceeds 3x the median PSD of 40-90 Hz earns a notch (w=6);
 * its second harmonic is tested the same way against 80-160 Hz (w=8).
 */
export function detectHumFromSamples(
  samples: Float32Array | Float64Array,
  sampleRate: number,
): NotchFilter[] {
  const { freqs, psd } = welchPsd(samples, sampleRate);

  const median = (loHz: number, hiHz: number): number => {
    const values: number[] = [];
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i]!;
      if (f >= loHz && f <= hiHz) values.push(psd[i]!);
    }
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    return values.length % 2 === 1
      ? values[mid]!
      : (values[mid - 1]! + values[mid]!) / 2;
  };

  const peak = (
    loHz: number,
    hiHz: number,
  ): { freq: number; power: number } | null => {
    let bestIdx = -1;
    let bestPower = -Infinity;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i]!;
      if (f >= loHz && f <= hiHz && psd[i]! > bestPower) {
        bestPower = psd[i]!;
        bestIdx = i;
      }
    }
    return bestIdx === -1 ? null : { freq: freqs[bestIdx]!, power: bestPower };
  };

  const medianLow = median(40, 90);
  const medianHarmonic = median(80, 160);
  if (medianLow <= 0) return [];

  // Mains hum has exactly one fundamental (50 or 60 Hz region; tape flutter
  // can pull it a few Hz off nominal). mejora_audio.py tested both windows
  // independently at 44.1 kHz, where 5.4 Hz FFT bins keep them disjoint; at
  // our 16 kHz analysis rate the windows sit close enough that leakage from a
  // true 60 Hz hum can also trip the 50 Hz test. Picking the stronger
  // candidate preserves the original intent and removes the ghost notch.
  const candidates = [peak(47, 53), peak(57, 63)].filter(
    (candidate): candidate is { freq: number; power: number } => candidate !== null,
  );
  if (candidates.length === 0) return [];
  const fundamental = candidates.reduce((best, candidate) =>
    candidate.power > best.power ? candidate : best,
  );
  if (fundamental.power <= HUM_RATIO * medianLow) return [];

  const notches: NotchFilter[] = [
    { freq: fundamental.freq, widthHz: 6, kind: "hum" },
  ];

  const harmonic = peak(2 * fundamental.freq - 6, 2 * fundamental.freq + 6);
  if (harmonic && harmonic.power > HUM_RATIO * medianHarmonic) {
    notches.push({ freq: harmonic.freq, widthHz: 8, kind: "harmonic" });
  }

  return notches;
}

/**
 * Feedback-howl detection (port of mejora_audio.py detect_howl): a dominant
 * tone in 500 Hz-7 kHz whose frequency stays within ±12 Hz across >=70% of
 * 10-second blocks, each block >=12 dB over its own band median. Max 2 notches.
 */
export function detectHowlFromSamples(
  samples: Float32Array | Float64Array,
  sampleRate: number,
): NotchFilter[] {
  const blockSize = HOWL_BLOCK_SECONDS * sampleRate;
  const blockCount = Math.floor(samples.length / blockSize);
  if (blockCount < HOWL_MIN_BLOCKS) return [];

  const dominantFreqs: number[] = [];
  const margins: number[] = [];

  for (let b = 0; b < blockCount; b++) {
    const block = samples.subarray(b * blockSize, (b + 1) * blockSize);
    const { freqs, psd } = welchPsd(block, sampleRate);

    let bestIdx = -1;
    let bestPower = -Infinity;
    const bandPowers: number[] = [];
    const bandFreqs: number[] = [];
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i]!;
      if (f > 500 && f < HOWL_MAX_FREQ) {
        bandPowers.push(psd[i]!);
        bandFreqs.push(f);
        if (psd[i]! > bestPower) {
          bestPower = psd[i]!;
          bestIdx = bandPowers.length - 1;
        }
      }
    }
    if (bestIdx === -1) continue;

    bandPowers.sort((a, b) => a - b);
    const mid = bandPowers.length >> 1;
    const bandMedian = bandPowers.length % 2 === 1
      ? bandPowers[mid]!
      : (bandPowers[mid - 1]! + bandPowers[mid]!) / 2;

    dominantFreqs.push(bandFreqs[bestIdx]!);
    margins.push(10 * Math.log10(Math.max(bestPower, 1e-30) / Math.max(bandMedian, 1e-30)));
  }

  // Cluster dominant tones within ±12 Hz (running-mean centers, first match).
  const clusters: number[][] = [];
  const centers: number[] = [];
  for (let k = 0; k < dominantFreqs.length; k++) {
    const f = dominantFreqs[k]!;
    let hit = -1;
    for (let c = 0; c < centers.length; c++) {
      if (Math.abs(f - centers[c]!) <= 12) {
        hit = c;
        break;
      }
    }
    if (hit === -1) {
      clusters.push([k]);
      centers.push(f);
    } else {
      clusters[hit]!.push(k);
      const members = clusters[hit]!;
      centers[hit] = members.reduce((sum, i2) => sum + dominantFreqs[i2]!, 0) / members.length;
    }
  }

  const candidates: Array<{ ratio: number; center: number }> = [];
  for (let c = 0; c < centers.length; c++) {
    const members = clusters[c]!;
    const supported = members.filter((k) => margins[k]! >= HOWL_MARGIN_DB).length;
    const ratio = supported / blockCount;
    if (ratio >= HOWL_MIN_BLOCK_FRACTION && centers[c]! > 500 && centers[c]! < HOWL_MAX_FREQ) {
      candidates.push({ ratio, center: centers[c]! });
    }
  }

  candidates.sort((a, b) => b.ratio - a.ratio);
  return candidates
    .slice(0, 2)
    .map(({ center }) => ({ freq: center, widthHz: 25, kind: "howl" as const }));
}

/** Format one notch as an ffmpeg bandreject filter. */
export function notchToAf(notch: NotchFilter): string {
  return `bandreject=f=${notch.freq.toFixed(1)}:width_type=h:w=${notch.widthHz}`;
}

/** Format a notch list as a comma-joined ffmpeg filter fragment. */
export function notchesToAf(notches: NotchFilter[]): string {
  return notches.map(notchToAf).join(",");
}
