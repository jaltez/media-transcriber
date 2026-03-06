import { describe, expect, it } from "vitest";
import { formatHuman } from "./formatter.js";
import type { BatchResult } from "../types/index.js";

describe("formatHuman", () => {
  it("prints output directory when only SRT output exists", () => {
    const result: BatchResult = {
      files: [
        {
          input: "input/audio.wav",
          output: {
            txt: null,
            srt: "C:\\work\\out\\audio.srt",
          },
          durationSeconds: 42,
          backend: "whisper-local",
          model: "large-v2",
          success: true,
        },
      ],
      summary: {
        totalFiles: 1,
        successful: 1,
        failed: 0,
        elapsed: 1200,
      },
    };

    const text = formatHuman(result);
    expect(text).toContain("Output:");
    expect(text).toContain("C:\\work\\out");
  });
});
