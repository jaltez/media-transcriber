import { describe, it, expect } from "vitest";
import {
  detectHumFromSamples,
  detectHowlFromSamples,
  notchesToAf,
} from "./analysis.js";

const SR = 16000;

/** Deterministic PRNG (mulberry32) so detection tests never flake. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synth(
  seconds: number,
  tones: Array<{ freq: number; amp: number }>,
  noiseAmp: number,
  seed = 42,
): Float64Array {
  const random = rng(seed);
  const samples = new Float64Array(seconds * SR);
  for (let i = 0; i < samples.length; i++) {
    const t = i / SR;
    let value = (random() * 2 - 1) * noiseAmp;
    for (const { freq, amp } of tones) {
      value += amp * Math.sin(2 * Math.PI * freq * t);
    }
    samples[i] = value;
  }
  return samples;
}

describe("detectHumFromSamples", () => {
  it("notches an off-nominal 50 Hz-region fundamental (48.4 Hz, as on the cassettes)", () => {
    const samples = synth(60, [{ freq: 48.4, amp: 0.2 }], 0.002);
    const notches = detectHumFromSamples(samples, SR);

    const fundamental = notches.find((n) => n.kind === "hum");
    expect(fundamental).toBeDefined();
    expect(fundamental!.freq).toBeGreaterThan(47);
    expect(fundamental!.freq).toBeLessThan(53);
    expect(fundamental!.widthHz).toBe(6);
  });

  it("notches a 60 Hz-region fundamental (59.2 Hz case from the corpus)", () => {
    const samples = synth(60, [{ freq: 59.2, amp: 0.2 }], 0.002);
    const notches = detectHumFromSamples(samples, SR);

    const fundamental = notches.find((n) => n.kind === "hum");
    expect(fundamental).toBeDefined();
    expect(fundamental!.freq).toBeGreaterThan(57);
    expect(fundamental!.freq).toBeLessThan(63);
  });

  it("adds a wider harmonic notch when the second harmonic also stands out", () => {
    const samples = synth(60, [
      { freq: 48.4, amp: 0.2 },
      { freq: 96.8, amp: 0.1 },
    ], 0.002);
    const notches = detectHumFromSamples(samples, SR);

    const harmonic = notches.find((n) => n.kind === "harmonic");
    expect(harmonic).toBeDefined();
    expect(harmonic!.freq).toBeGreaterThan(90);
    expect(harmonic!.freq).toBeLessThan(103);
    expect(harmonic!.widthHz).toBe(8);
    expect(notches.find((n) => n.kind === "hum")).toBeDefined();
  });

  it("returns nothing for clean noise", () => {
    const samples = synth(60, [], 0.05);
    expect(detectHumFromSamples(samples, SR)).toEqual([]);
  });
});

describe("detectHowlFromSamples", () => {
  it("notches a sustained tone present in every block", () => {
    // 12 blocks of 10 s (needs >= 10 blocks); strong 1500 Hz feedback tone.
    const samples = synth(120, [{ freq: 1500, amp: 0.1 }], 0.002);
    const notches = detectHowlFromSamples(samples, SR);

    expect(notches.length).toBe(1);
    expect(notches[0]!.freq).toBeGreaterThan(1488);
    expect(notches[0]!.freq).toBeLessThan(1512);
    expect(notches[0]!.widthHz).toBe(25);
    expect(notches[0]!.kind).toBe("howl");
  });

  it("ignores a tone that appears in fewer than 70% of blocks", () => {
    const random = rng(7);
    const samples = new Float64Array(120 * SR);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = (random() * 2 - 1) * 0.002;
    }
    // Tone only in blocks 0-4 (5 of 12 = 42%).
    for (let b = 0; b < 5; b++) {
      for (let i = b * 10 * SR; i < (b + 1) * 10 * SR; i++) {
        samples[i]! += 0.1 * Math.sin(2 * Math.PI * 1500 * (i / SR));
      }
    }
    expect(detectHowlFromSamples(samples, SR)).toEqual([]);
  });

  it("returns nothing for recordings shorter than 10 blocks", () => {
    const samples = synth(90, [{ freq: 1500, amp: 0.1 }], 0.002);
    expect(detectHowlFromSamples(samples, SR)).toEqual([]);
  });
});

describe("notchesToAf", () => {
  it("formats bandreject filters with one-decimal frequencies", () => {
    expect(notchesToAf([{ freq: 48.4, widthHz: 6, kind: "hum" }]))
      .toBe("bandreject=f=48.4:width_type=h:w=6");
    expect(
      notchesToAf([
        { freq: 48.4, widthHz: 6, kind: "hum" },
        { freq: 102.3, widthHz: 8, kind: "harmonic" },
      ]),
    ).toBe("bandreject=f=48.4:width_type=h:w=6,bandreject=f=102.3:width_type=h:w=8");
  });
});
