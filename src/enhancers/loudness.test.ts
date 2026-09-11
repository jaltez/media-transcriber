import { describe, it, expect } from "vitest";
import { parseLoudnormJson, parseEbur128 } from "./loudness.js";
import { mergeEnhancementReports } from "./chain.js";
import type { EnhancementReport } from "../types/index.js";

const LOUDNORM_STDERR = `
[Parsed_loudnorm_0 @ 0x55f] size is 460800
{
	"input_i" : "-27.93",
	"input_tp" : "-11.45",
	"input_lra" : "4.90",
	"input_thresh" : "-39.61",
	"output_i" : "-15.68",
	"output_tp" : "-1.49",
	"output_lra" : "4.10",
	"output_thresh" : "-25.42",
	"normalization_type" : "dynamic",
	"target_offset" : "0.32"
}
`;

describe("parseLoudnormJson", () => {
  it("extracts the five measurement fields from loudnorm JSON output", () => {
    const measurement = parseLoudnormJson(LOUDNORM_STDERR);
    expect(measurement).not.toBeNull();
    expect(measurement!.inputI).toBeCloseTo(-27.93, 5);
    expect(measurement!.inputTp).toBeCloseTo(-11.45, 5);
    expect(measurement!.inputLra).toBeCloseTo(4.9, 5);
    expect(measurement!.inputThresh).toBeCloseTo(-39.61, 5);
    expect(measurement!.targetOffset).toBeCloseTo(0.32, 5);
  });

  it("returns null when no JSON block is present", () => {
    expect(parseLoudnormJson("no measurements here")).toBeNull();
  });

  it("returns null for JSON blocks without input_i", () => {
    expect(parseLoudnormJson('{"unrelated": true}')).toBeNull();
  });
});

describe("parseEbur128", () => {
  it("extracts the final integrated loudness and true peak", () => {
    const stderr = `
      Summary:
        Integrated loudness:
          I:         -23.5 LUFS
          Threshold: -33.6 LUFS
        Loudness range:
          LRA:       5.0 LU
        True peak:
          Peak:      -1.2 dBTP
    `;
    const stats = parseEbur128(stderr);
    expect(stats.lufs).toBeCloseTo(-23.5, 5);
    expect(stats.truePeakDbtp).toBeCloseTo(-1.2, 5);
  });

  it("leaves values undefined when the summary is missing", () => {
    const stats = parseEbur128("nothing to parse");
    expect(stats.lufs).toBeUndefined();
    expect(stats.truePeakDbtp).toBeUndefined();
  });
});

function reportFixture(overrides: Partial<EnhancementReport> = {}): EnhancementReport {
  return {
    engine: "basic",
    analysis: { humNotches: [], howlNotches: [] },
    filterChain: "highpass=f=70 | afftdn=nr=12",
    profile: "asr",
    timings: { analysisMs: 100, engineMs: 200, totalMs: 350 },
    parts: 1,
    outputFile: "/tmp/part1.mp3",
    ...overrides,
  };
}

describe("mergeEnhancementReports", () => {
  it("returns undefined for no reports", () => {
    expect(mergeEnhancementReports([], "/tmp/out.mp3")).toBeUndefined();
  });

  it("keeps a single report and only rewrites the output path", () => {
    const merged = mergeEnhancementReports([reportFixture()], "/tmp/final.mp3")!;
    expect(merged.parts).toBe(1);
    expect(merged.outputFile).toBe("/tmp/final.mp3");
    expect(merged.filterChain).toBe("highpass=f=70 | afftdn=nr=12");
  });

  it("sums timings and counts parts when merging split-part reports", () => {
    const second = reportFixture({
      timings: { analysisMs: 50, engineMs: 300, totalMs: 400 },
      outputFile: "/tmp/part2.mp3",
    });
    const merged = mergeEnhancementReports(
      [reportFixture(), second],
      "/tmp/final.mp3",
    )!;
    expect(merged.parts).toBe(2);
    expect(merged.timings).toEqual({ analysisMs: 150, engineMs: 500, totalMs: 750 });
    expect(merged.outputFile).toBe("/tmp/final.mp3");
  });
});
