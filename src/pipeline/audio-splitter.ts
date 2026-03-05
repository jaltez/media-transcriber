import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * Get audio duration in seconds using ffprobe.
 * Port of lib/audio_splitter.py get_audio_duration()
 */
export async function getAudioDuration(inputFile: string): Promise<number> {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const result = await execa("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    inputFile,
  ]);

  const duration = parseFloat(result.stdout.trim());
  if (isNaN(duration)) {
    throw new Error(`Invalid duration output: ${result.stdout}`);
  }

  return duration;
}

/**
 * Split audio file into multiple equal-length parts.
 * Port of lib/audio_splitter.py split_audio()
 */
export async function splitAudio(
  inputFile: string,
  numParts: number,
  outputFolder: string,
  outputPrefix?: string,
): Promise<string[]> {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }
  if (numParts < 1) {
    throw new Error("numParts must be at least 1");
  }

  await mkdir(outputFolder, { recursive: true });

  const ext = extname(inputFile);
  const stem = basename(inputFile, ext);
  const prefix = outputPrefix || stem;

  const duration = await getAudioDuration(inputFile);
  const partDuration = Math.floor(duration / numParts);

  const splitFiles: string[] = [];

  for (let i = 1; i <= numParts; i++) {
    const startTime = (i - 1) * partDuration;
    const partNum = String(i).padStart(2, "0");
    const outputFile = join(outputFolder, `${prefix}_part${partNum}${ext}`);

    const args = [
      "-i", inputFile,
      "-ss", String(startTime),
    ];

    // Last part: go to end of file; others: specify duration
    if (i < numParts) {
      args.push("-t", String(partDuration));
    }

    args.push("-c", "copy", "-y", outputFile);

    await execa("ffmpeg", args);

    if (!existsSync(outputFile)) {
      throw new Error(`Split failed: output file not created for part ${i}`);
    }

    splitFiles.push(outputFile);
  }

  return splitFiles;
}
