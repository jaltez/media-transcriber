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
    expect(config.enhancer).toBe("none");
    expect(config.enhanceProfile).toBe("asr");
    expect(config.enhanceOptions.declick).toBe(false);
    expect(config.enhanceOptions.humNotch).toBe(true);
    expect(config.enhanceOptions.howlNotch).toBe(false);
    expect(config.allowUpload).toBe(false);
    expect(config.keepIntermediateFiles).toBe(false);
    expect(config.outputFormats).toEqual(["txt", "srt"]);
  });

  it("accepts valid overrides", () => {
    const config = configSchema.parse({
      backend: "whisper-api",
      device: "cpu",
      localWhisperCommand: "whisper",
      maxDurationSeconds: 600,
      enhancer: "deepfilternet",
      enhanceProfile: "master",
      enhanceOptions: {
        declick: true,
        howlNotch: true,
        dfnAttenLimDb: 12,
        loudnessTargetLufs: -18,
      },
      allowUpload: true,
    });
    expect(config.backend).toBe("whisper-api");
    expect(config.device).toBe("cpu");
    expect(config.localWhisperCommand).toBe("whisper");
    expect(config.maxDurationSeconds).toBe(600);
    expect(config.enhancer).toBe("deepfilternet");
    expect(config.enhanceProfile).toBe("master");
    expect(config.enhanceOptions.declick).toBe(true);
    expect(config.enhanceOptions.howlNotch).toBe(true);
    expect(config.enhanceOptions.dfnAttenLimDb).toBe(12);
    expect(config.enhanceOptions.loudnessTargetLufs).toBe(-18);
  });

  it("rejects invalid device", () => {
    expect(() => configSchema.parse({ device: "tpu" })).toThrow();
  });

  it("rejects negative maxDurationSeconds", () => {
    expect(() => configSchema.parse({ maxDurationSeconds: -1 })).toThrow();
  });

  it("rejects unknown enhancers and profiles", () => {
    expect(() => configSchema.parse({ enhancer: "sox" })).toThrow();
    expect(() => configSchema.parse({ enhanceProfile: "studio" })).toThrow();
  });

  it("rejects out-of-range enhancement options", () => {
    expect(() => configSchema.parse({ enhanceOptions: { dfnAttenLimDb: 99 } })).toThrow();
    expect(() => configSchema.parse({ enhanceOptions: { loudnessTargetLufs: 0 } })).toThrow();
  });

  it("provides valid defaultConfig export", () => {
    expect(defaultConfig.backend).toBe("whisper-local");
    expect(defaultConfig.whisperModel).toBe("large-v2");
    expect(defaultConfig.device).toBe("auto");
    expect(defaultConfig.outputFormats).toContain("srt");
    expect(defaultConfig.enhancer).toBe("none");
  });

  it("fills inner enhanceOptions defaults for parse({}) (zod v3 semantics)", () => {
    // Guards the .default({}) pattern: if a zod upgrade stops parsing
    // defaults through the inner schema, humNotch would become undefined
    // (falsy) and hum analysis would silently stop running.
    expect(defaultConfig.enhanceOptions.loudnessTargetLufs).toBe(-16);
    expect(configSchema.parse({}).enhanceOptions.humNotch).toBe(true);
  });
});
