import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * Enhance audio quality using ffmpeg filter chain.
 * Applies: noise reduction → compression → loudness normalization.
 * Port of lib/audio_enhancer.py enhance_audio()
 */
export async function enhanceAudio(
  inputFile: string,
  outputFolder: string,
): Promise<string> {
  if (!existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  await mkdir(outputFolder, { recursive: true });

  const ext = extname(inputFile);
  const stem = basename(inputFile, ext);
  const outputFile = join(outputFolder, `${stem}_enhanced${ext}`);

  const audioFilter = [
    "afftdn=nf=-20",
    "acompressor=ratio=4:threshold=0.1:attack=10:release=100",
    "loudnorm=I=-16:LRA=11:tp=-1.5",
  ].join(",");

  await execa("ffmpeg", [
    "-i", inputFile,
    "-af", audioFilter,
    "-y",
    outputFile,
  ]);

  if (!existsSync(outputFile)) {
    throw new Error("Enhancement failed: output file not created");
  }

  return outputFile;
}
