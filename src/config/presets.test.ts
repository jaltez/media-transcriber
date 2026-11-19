import { describe, expect, it } from "vitest";
import { isQualityPreset, modelForPreset } from "./presets.js";

describe("quality presets", () => {
  it("recognizes supported preset names", () => {
    expect(isQualityPreset("fast")).toBe(true);
    expect(isQualityPreset("balanced")).toBe(true);
    expect(isQualityPreset("accurate")).toBe(true);
    expect(isQualityPreset("huge")).toBe(false);
  });

  it("maps local presets to local Whisper models", () => {
    expect(modelForPreset("fast", "whisper-local", "base")).toBe("base");
    expect(modelForPreset("balanced", "whisper-local", "base")).toBe("small");
    expect(modelForPreset("accurate", "whisper-local", "base")).toBe("large-v3");
  });

  it("maps presets on every Whisper-weights backend", () => {
    expect(modelForPreset("accurate", "faster-whisper", "turbo")).toBe("large-v3");
    expect(modelForPreset("accurate", "whisper-cpp", "turbo")).toBe("large-v3");
    expect(modelForPreset("fast", "faster-whisper", "turbo")).toBe("base");
    expect(modelForPreset("balanced", "whisper-cpp", "turbo")).toBe("small");
  });

  it("uses the backend default for non-Whisper backends", () => {
    expect(modelForPreset("accurate", "whisper-api", "whisper-1")).toBe("whisper-1");
    expect(modelForPreset("accurate", "parakeet", "parakeet-tdt-0.6b-v3")).toBe("parakeet-tdt-0.6b-v3");
  });
});