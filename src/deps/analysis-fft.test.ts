import { describe, it, expect } from "vitest";
import { fftInPlace, hannWindow, welchPsd } from "./analysis-fft.js";

describe("fftInPlace", () => {
  it("peaks at the bin of a pure sine", () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const bin = 37;
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin((2 * Math.PI * bin * i) / n);
    }
    fftInPlace(re, im);

    let best = 0;
    for (let i = 1; i <= n / 2; i++) {
      if (re[i]! * re[i]! + im[i]! * im[i]! > re[best]! * re[best]! + im[best]! * im[best]!) {
        best = i;
      }
    }
    expect(best).toBe(bin);
  });

  it("rejects non-power-of-two lengths", () => {
    expect(() => fftInPlace(new Float64Array(1000), new Float64Array(1000))).toThrow(/power of two/);
  });
});

describe("welchPsd", () => {
  it("places a 48.4 Hz tone in the right frequency bin", () => {
    const sr = 16000;
    const seconds = 4;
    const samples = new Float64Array(sr * seconds);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(2 * Math.PI * 48.4 * (i / sr));
    }
    const { freqs, psd } = welchPsd(samples, sr);

    let best = 0;
    for (let i = 1; i < psd.length; i++) {
      if (psd[i]! > psd[best]!) best = i;
    }
    expect(freqs[best]!).toBeGreaterThan(47);
    expect(freqs[best]!).toBeLessThan(53);
    expect(freqs.length).toBe(8192 / 2 + 1);
    expect(freqs[freqs.length - 1]!).toBeCloseTo(sr / 2, 5);
  });

  it("handles signals shorter than one window (single zero-padded frame)", () => {
    const samples = new Float64Array(1000).map((_, i) => Math.sin(i / 20));
    const { psd } = welchPsd(samples, 16000);
    expect(psd.some((v) => v > 0)).toBe(true);
  });

  it("rejects non-power-of-two windows", () => {
    expect(() => welchPsd(new Float64Array(100), 16000, 8000)).toThrow(/power of two/);
  });
});

describe("hannWindow", () => {
  it("is zero at the edges and ~1 in the middle", () => {
    const w = hannWindow(8);
    expect(w[0]!).toBeCloseTo(0, 10);
    expect(w[4]!).toBeCloseTo(1, 10);
    expect(w.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});
