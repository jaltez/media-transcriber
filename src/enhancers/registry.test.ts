import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEnhancer,
  listEnhancers,
  registerBuiltinEnhancers,
} from "./registry.js";
import { isEnhancerId } from "../types/index.js";
import { runEnhancement } from "./chain.js";
import { BasicEnhancer } from "./basic.js";

const ffmpegAvailable = await execa("ffmpeg", ["-version"], { reject: false })
  .then((r) => r.exitCode === 0)
  .catch(() => false);

describe("enhancer registry", () => {
  it("registers all built-in enhancers", () => {
    registerBuiltinEnhancers();
    expect(listEnhancers().sort()).toEqual(["basic", "deepfilternet", "unise"]);
    expect(getEnhancer("basic")?.displayName).toBe("FFmpeg (built-in)");
    expect(getEnhancer("unise")?.requiresUpload).toBe(true);
    expect(getEnhancer("basic")?.requiresUpload).toBe(false);
  });

  it("isEnhancerId guards the engine id union", () => {
    expect(isEnhancerId("basic")).toBe(true);
    expect(isEnhancerId("unise")).toBe(true);
    expect(isEnhancerId("sox")).toBe(false);
    expect(isEnhancerId("")).toBe(false);
  });
});

describe("basic enhancer availability", () => {
  it("reports availability driven by ffmpeg", async () => {
    const enhancer = new BasicEnhancer();
    const status = await enhancer.checkAvailability();
    expect(status.available).toBe(ffmpegAvailable);
  });
});

describe.skipIf(!ffmpegAvailable)("runEnhancement end-to-end (basic engine)", () => {
  async function makeNoisyInput(dir: string): Promise<string> {
    const input = join(dir, "noisy.wav");
    await execa("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=50:duration=4",
      "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=4:amplitude=0.02",
      "-filter_complex", "[0:a][1:a][2:a]amix=inputs=3:duration=first:normalize=0",
      "-ar", "44100",
      "-c:a", "pcm_s16le",
      input,
    ]);
    return input;
  }

  it("enhances, notches detected hum, and reports the chain", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "mt-enhance-test-"));
    try {
      const input = await makeNoisyInput(workDir);
      const { outputFile, report } = await runEnhancement({
        inputFile: input,
        outputFolder: join(workDir, "temp"),
        baseName: "clip",
        enhancer: new BasicEnhancer(),
        options: {
          profile: "asr",
          declick: false,
          humNotch: true,
          howlNotch: false,
          loudnessTargetLufs: -16,
          allowUpload: false,
        },
        outputExt: ".mp3",
      });

      const info = await stat(outputFile);
      expect(info.size).toBeGreaterThan(1000);
      expect(report.engine).toBe("basic");
      expect(report.profile).toBe("asr");
      expect(report.parts).toBe(1);
      // The synthetic 50 Hz hum must have earned a notch near 50 Hz.
      expect(report.analysis.humNotches.length).toBeGreaterThanOrEqual(1);
      expect(report.analysis.humNotches[0]!.freq).toBeGreaterThan(47);
      expect(report.analysis.humNotches[0]!.freq).toBeLessThan(53);
      // Transparency: the exact ffmpeg stages are in the report.
      expect(report.filterChain).toContain("highpass=f=70");
      expect(report.filterChain).toContain("bandreject=f=5");
      expect(report.filterChain).toContain("afftdn=nr=12");
      expect(report.timings.totalMs).toBeGreaterThan(0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("master profile normalizes to the loudness target and reports it", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "mt-enhance-master-"));
    try {
      const input = await makeNoisyInput(workDir);
      const { outputFile, report } = await runEnhancement({
        inputFile: input,
        outputFolder: join(workDir, "temp"),
        baseName: "clip",
        enhancer: new BasicEnhancer(),
        options: {
          profile: "master",
          declick: true,
          humNotch: true,
          howlNotch: false,
          loudnessTargetLufs: -16,
          allowUpload: false,
        },
        outputExt: ".wav",
      });

      await stat(outputFile);
      expect(report.profile).toBe("master");
      expect(report.filterChain).toContain("adeclick");
      expect(report.filterChain).toContain("acompressor");
      expect(report.filterChain).toContain("loudnorm=I=-16");
      expect(report.loudness?.afterLufs).toBeDefined();
      expect(Math.abs(report.loudness!.afterLufs! - -16)).toBeLessThan(2);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);
});
