import { checkCommand } from "./checker.js";
import type { DependencyStatus } from "../types/index.js";

/** Check both ffmpeg and ffprobe availability */
export async function checkFfmpeg(): Promise<{
  ffmpeg: DependencyStatus;
  ffprobe: DependencyStatus;
}> {
  const [ffmpeg, ffprobe] = await Promise.all([
    checkCommand("ffmpeg", "-version"),
    checkCommand("ffprobe", "-version"),
  ]);
  return { ffmpeg, ffprobe };
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
