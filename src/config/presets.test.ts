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
    expect(modelForPreset("accurate", "whisper-local", "base")).toBe("large-v2");
  });

  it("uses the backend default for non-local backends", () => {
    expect(modelForPreset("accurate", "whisper-api", "whisper-1")).toBe("whisper-1");
  });
});