import { describe, it, expect } from "vitest";
import { configSchema, defaultConfig } from "./schema.js";

describe("configSchema", () => {
  it("parses an empty object with defaults", () => {
    const config = configSchema.parse({});
    expect(config.inputFolder).toBe("./data/input");
    expect(config.outputFolder).toBe("./data/output");
    expect(config.backend).toBe("whisper-local");
    expect(config.whisperModel).toBe("large-v2");
    expect(config.device).toBe("auto");
    expect(config.maxDurationSeconds).toBe(1200);
    expect(config.enableAudioEnhancement).toBe(false);
    expect(config.keepIntermediateFiles).toBe(false);
    expect(config.outputFormats).toEqual(["txt", "srt"]);
  });

  it("accepts valid overrides", () => {
    const config = configSchema.parse({
      backend: "whisper-api",
      device: "cpu",
      localWhisperCommand: "whisper",
      maxDurationSeconds: 600,
      enableAudioEnhancement: true,
    });
    expect(config.backend).toBe("whisper-api");
    expect(config.device).toBe("cpu");
    expect(config.localWhisperCommand).toBe("whisper");
    expect(config.maxDurationSeconds).toBe(600);
    expect(config.enableAudioEnhancement).toBe(true);
  });

  it("rejects invalid device", () => {
    expect(() => configSchema.parse({ device: "tpu" })).toThrow();
  });

  it("rejects negative maxDurationSeconds", () => {
    expect(() => configSchema.parse({ maxDurationSeconds: -1 })).toThrow();
  });

  it("provides valid defaultConfig export", () => {
    expect(defaultConfig.backend).toBe("whisper-local");
    expect(defaultConfig.whisperModel).toBe("large-v2");
    expect(defaultConfig.device).toBe("auto");
    expect(defaultConfig.outputFormats).toContain("srt");
  });
});
