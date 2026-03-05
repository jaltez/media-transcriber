import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TranscriptSegment, SrtEntry } from "../types/index.js";

/**
 * Parse SRT timestamp string "HH:MM:SS,mmm" to milliseconds.
 */
export function parseSrtTimestamp(timestamp: string): number {
  const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!match) return 0;

  const [, hours, minutes, seconds, ms] = match;
  return (
    parseInt(hours!) * 3600000 +
    parseInt(minutes!) * 60000 +
    parseInt(seconds!) * 1000 +
    parseInt(ms!)
  );
}

/**
 * Format milliseconds to SRT timestamp "HH:MM:SS,mmm".
 */
export function formatSrtTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "," +
    String(milliseconds).padStart(3, "0")
  );
}

/**
 * Parse an SRT file into structured entries.
 */
export function parseSrt(content: string): SrtEntry[] {
  const entries: SrtEntry[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!.trim();

    // Look for subtitle index (a number on its own line)
    if (/^\d+$/.test(line)) {
      const index = parseInt(line);
      i++;

      // Next line should be timestamp
      if (i >= lines.length) break;
      const timestampLine = lines[i]!.trim();
      const tsMatch = timestampLine.match(
        /(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/,
      );

      if (tsMatch) {
        const startTime = parseSrtTimestamp(tsMatch[1]!);
        const endTime = parseSrtTimestamp(tsMatch[2]!);
        i++;

        // Collect text lines until blank line or end
        const textLines: string[] = [];
        while (i < lines.length && lines[i]!.trim() !== "") {
          textLines.push(lines[i]!.trim());
          i++;
        }

        entries.push({
          index,
          startTime,
          endTime,
          text: textLines.join("\n"),
        });
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return entries;
}

/**
 * Merge multiple transcript parts into single txt and srt files.
 * Re-numbers subtitles sequentially and adjusts timestamps with cumulative offset.
 * Port of lib/transcript_merger.py merge_transcripts()
 */
export async function mergeTranscripts(
  parts: TranscriptSegment[],
  outputTxt: string,
  outputSrt: string,
): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

  // Merge TXT files
  const txtParts: string[] = [];
  for (const part of sorted) {
    if (part.txtFile && existsSync(part.txtFile)) {
      const content = await readFile(part.txtFile, "utf-8");
      txtParts.push(content);
    }
  }

  await mkdir(dirname(outputTxt), { recursive: true });
  await writeFile(outputTxt, txtParts.join("\n"), "utf-8");

  // Merge SRT files with timestamp adjustment
  const allEntries: SrtEntry[] = [];
  let cumulativeOffset = 0;

  for (const part of sorted) {
    if (!part.srtFile || !existsSync(part.srtFile)) continue;

    const content = await readFile(part.srtFile, "utf-8");
    const entries = parseSrt(content);

    let lastEndTime = 0;
    for (const entry of entries) {
      allEntries.push({
        index: allEntries.length + 1,
        startTime: entry.startTime + cumulativeOffset,
        endTime: entry.endTime + cumulativeOffset,
        text: entry.text,
      });
      lastEndTime = entry.endTime + cumulativeOffset;
    }

    if (lastEndTime > 0) {
      cumulativeOffset = lastEndTime;
    }
  }

  // Write merged SRT
  const srtLines: string[] = [];
  for (const entry of allEntries) {
    srtLines.push(String(entry.index));
    srtLines.push(
      `${formatSrtTimestamp(entry.startTime)} --> ${formatSrtTimestamp(entry.endTime)}`,
    );
    srtLines.push(entry.text);
    srtLines.push("");
  }

  await mkdir(dirname(outputSrt), { recursive: true });
  await writeFile(outputSrt, srtLines.join("\n"), "utf-8");
}
