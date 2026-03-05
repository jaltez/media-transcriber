import { execa } from "execa";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Convert audio/video file to MP3 format using ffmpeg.
 * Port of lib/audio_converter.py convert_to_mp3()
 */
export async function convertToMp3(
  inputFile: string,
  outputFolder: string,
  quality = 2,
): Promise<string> {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  await mkdir(outputFolder, { recursive: true });

  const stem = basename(inputFile, extname(inputFile));
  const outputFile = join(outputFolder, `${stem}.mp3`);

  await execa("ffmpeg", [
    "-i", inputFile,
    "-vn",
    "-codec:a", "libmp3lame",
    "-q:a", String(quality),
    "-y",
    outputFile,
  ]);

  if (!existsSync(outputFile)) {
    throw new Error("Conversion failed: output file not created");
  }

  return outputFile;
}
