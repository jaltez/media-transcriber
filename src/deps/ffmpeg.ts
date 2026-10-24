import { checkCommand } from "./checker.js";
import { PROBE_CACHE_KEYS, withProbeCache } from "./cache.js";
import type { DependencyStatus } from "../types/index.js";

export interface FfmpegStatus {
  ffmpeg: DependencyStatus;
  ffprobe: DependencyStatus;
}

// One shared promise per process so doctor's dependency check, the basic
// enhancer, and transcribe's preflight never spawn ffmpeg twice in a run.
let ffmpegCheck: Promise<FfmpegStatus> | null = null;

/** Check both ffmpeg and ffprobe availability */
export function checkFfmpeg(): Promise<FfmpegStatus> {
  ffmpegCheck ??= withProbeCache(
    PROBE_CACHE_KEYS.ffmpeg,
    (status) => status.ffmpeg.available && status.ffprobe.available,
    async () => {
      const [ffmpeg, ffprobe] = await Promise.all([
        checkCommand("ffmpeg", "-version"),
        checkCommand("ffprobe", "-version"),
      ]);
      return { ffmpeg, ffprobe };
    },
  );
  return ffmpegCheck;
}

/** Reset the in-process memo (used by tests). */
export function resetFfmpegCheck(): void {
  ffmpegCheck = null;
}

/** Format FFmpeg status for display */
export function formatFfmpegStatus(status: {
  ffmpeg: DependencyStatus;
  ffprobe: DependencyStatus;
}): string {
  const lines: string[] = [];

  if (status.ffmpeg.available) {
    lines.push(`  ffmpeg:  ✓ ${status.ffmpeg.version ?? "found"}`);
  } else {
    lines.push(`  ffmpeg:  ✗ not found`);
    if (status.ffmpeg.installHint) {
      lines.push(`           ${status.ffmpeg.installHint}`);
    }
  }

  if (status.ffprobe.available) {
    lines.push(`  ffprobe: ✓ ${status.ffprobe.version ?? "found"}`);
  } else {
    lines.push(`  ffprobe: ✗ not found`);
    if (status.ffprobe.installHint) {
      lines.push(`           ${status.ffprobe.installHint}`);
    }
  }

  return lines.join("\n");
}
