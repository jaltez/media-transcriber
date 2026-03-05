import { readdir, cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import type { Config } from "../config/schema.js";
import type { TranscriptionBackend } from "../backends/types.js";
import type {
  FileResult,
  BatchResult,
  ProgressEvent,
} from "../types/index.js";
import { SUPPORTED_EXTENSIONS } from "../types/index.js";
import { convertToMp3 } from "./audio-converter.js";
import { getAudioDuration, splitAudio } from "./audio-splitter.js";
import { enhanceAudio } from "./audio-enhancer.js";
import { mergeTranscripts } from "./transcript-merger.js";

export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Discover supported audio/video files in a directory (recursive).
 */
export async function findInputFiles(inputFolder: string): Promise<string[]> {
  if (!existsSync(inputFolder)) {
    return [];
  }

  const files: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if ((SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(inputFolder);
  return files.sort();
}

/**
 * Process a single file through the transcription pipeline.
 */
async function processFile(
  filePath: string,
  config: Config,
  backend: TranscriptionBackend,
  fileNum: number,
  totalFiles: number,
  onProgress: ProgressCallback,
): Promise<FileResult> {
  const baseName = basename(filePath, extname(filePath));
  const tempFolder = config.tempFolder;
  const outputFolder = config.outputFolder;

  onProgress({ event: "file_start", file: filePath, fileNumber: fileNum, totalFiles });

  let durationSeconds = 0;

  try {
    // Step 1: Convert to MP3 if needed
    let mp3File: string;
    const convertedTarget = join(tempFolder, `${baseName}.mp3`);
    if (extname(filePath).toLowerCase() === ".mp3") {
      mp3File = filePath;
    } else {
      onProgress({
        event: "step_start",
        file: filePath,
        step: "convert",
        message: `${filePath} -> ${convertedTarget}`,
      });
      mp3File = await convertToMp3(filePath, tempFolder);
      onProgress({
        event: "step_complete",
        file: filePath,
        step: "convert",
        message: `Created ${mp3File}`,
      });
    }

    // Step 2: Check duration and split if necessary
    onProgress({
      event: "step_start",
      file: filePath,
      step: "check_duration",
      message: `Reading duration from ${mp3File}`,
    });
    durationSeconds = await getAudioDuration(mp3File);
    onProgress({
      event: "step_complete",
      file: filePath,
      step: "check_duration",
      message: `Duration ${Math.round(durationSeconds)}s (split threshold ${config.maxDurationSeconds}s)`,
    });

    const needsSplit = durationSeconds > config.maxDurationSeconds;
    let audioFiles: string[];

    if (needsSplit) {
      const numParts = Math.floor(durationSeconds / config.maxDurationSeconds) + 1;
      onProgress({
        event: "step_start",
        file: filePath,
        step: "split",
        message: `${Math.round(durationSeconds)}s file -> ${numParts} parts`,
      });
      audioFiles = await splitAudio(mp3File, numParts, tempFolder, baseName);
      onProgress({
        event: "step_complete",
        file: filePath,
        step: "split",
        message: `Created ${audioFiles.length} part(s)`,
      });
    } else {
      audioFiles = [mp3File];
    }

    // Step 3: Enhance audio if requested
    if (config.enableAudioEnhancement) {
      onProgress({
        event: "step_start",
        file: filePath,
        step: "enhance",
        message: `Enhancing ${audioFiles.length} file(s)`,
      });
      const enhanced: string[] = [];
      for (const audioFile of audioFiles) {
        const result = await enhanceAudio(audioFile, tempFolder);
        enhanced.push(result);
      }
      audioFiles = enhanced;
      onProgress({
        event: "step_complete",
        file: filePath,
        step: "enhance",
        message: `Enhanced ${audioFiles.length} file(s)`,
      });
    }

    // Step 4: Transcribe
    onProgress({
      event: "step_start",
      file: filePath,
      step: "transcribe",
      message: `${audioFiles.length} part(s), model=${config.whisperModel}, backend=${backend.name}`,
    });
    const transcriptParts = [];

    for (let i = 0; i < audioFiles.length; i++) {
      const audioFile = audioFiles[i]!;
      const partNum = i + 1;
      const partDir = join(tempFolder, `${baseName}_part${String(partNum).padStart(2, "0")}`);

      onProgress({
        event: "step_progress",
        file: filePath,
        step: "transcribe",
        current: partNum,
        total: audioFiles.length,
        message: basename(audioFile),
      });

      const segment = await backend.transcribe({
        inputFile: audioFile,
        model: config.whisperModel,
        device: config.device,
        outputDir: partDir,
      });

      transcriptParts.push({ ...segment, partNumber: partNum });
    }
    onProgress({
      event: "step_complete",
      file: filePath,
      step: "transcribe",
      message: `Completed ${transcriptParts.length} part(s)`,
    });

    // Step 5: Merge or copy output
    let outputTxt: string | null = null;
    let outputSrt: string | null = null;

    await mkdir(outputFolder, { recursive: true });

    if (transcriptParts.length > 1) {
      outputTxt = join(outputFolder, `${baseName}.txt`);
      outputSrt = join(outputFolder, `${baseName}.srt`);
      onProgress({
        event: "step_start",
        file: filePath,
        step: "merge",
        message: `${transcriptParts.length} parts -> ${outputTxt}, ${outputSrt}`,
      });
      await mergeTranscripts(transcriptParts, outputTxt, outputSrt);
      onProgress({
        event: "step_complete",
        file: filePath,
        step: "merge",
        message: `Merged outputs written`,
      });
    } else {
      onProgress({
        event: "step_start",
        file: filePath,
        step: "copy_output",
        message: `Copying transcript files to ${outputFolder}`,
      });
      const part = transcriptParts[0]!;
      if (part.txtFile && existsSync(part.txtFile)) {
        outputTxt = join(outputFolder, `${baseName}.txt`);
        await cp(part.txtFile, outputTxt);
      }
      if (part.srtFile && existsSync(part.srtFile)) {
        outputSrt = join(outputFolder, `${baseName}.srt`);
        await cp(part.srtFile, outputSrt);
      }
      onProgress({
        event: "step_complete",
        file: filePath,
        step: "copy_output",
        message: `Copied outputs (${outputTxt ? "txt" : ""}${outputTxt && outputSrt ? ", " : ""}${outputSrt ? "srt" : ""})`,
      });
    }

    onProgress({ event: "file_complete", file: filePath, success: true });

    return {
      input: filePath,
      output: { txt: outputTxt, srt: outputSrt },
      durationSeconds,
      backend: backend.name,
      model: config.whisperModel,
      success: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ event: "file_complete", file: filePath, success: false, error: message });

    return {
      input: filePath,
      output: { txt: null, srt: null },
      durationSeconds,
      backend: backend.name,
      model: config.whisperModel,
      success: false,
      error: message,
    };
  }
}

/**
 * Run the full batch transcription pipeline.
 */
export async function runPipeline(
  config: Config,
  backend: TranscriptionBackend,
  onProgress: ProgressCallback = () => {},
): Promise<BatchResult> {
  const startTime = Date.now();

  // Discover input files
  const inputFiles = await findInputFiles(config.inputFolder);

  onProgress({ event: "batch_start", totalFiles: inputFiles.length });

  // Process each file
  const results: FileResult[] = [];
  for (let i = 0; i < inputFiles.length; i++) {
    const result = await processFile(
      inputFiles[i]!,
      config,
      backend,
      i + 1,
      inputFiles.length,
      onProgress,
    );
    results.push(result);
  }

  // Cleanup temp files
  if (!config.keepIntermediateFiles && existsSync(config.tempFolder)) {
    await rm(config.tempFolder, { recursive: true, force: true });
  }

  const elapsed = Date.now() - startTime;
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  const summary = {
    totalFiles: results.length,
    successful,
    failed,
    elapsed,
  };

  onProgress({ event: "batch_complete", summary });

  return { files: results, summary };
}
