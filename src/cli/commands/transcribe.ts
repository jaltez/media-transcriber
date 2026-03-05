import { Command } from "commander";
import { configSchema, type Config } from "../../config/schema.js";
import { checkFfmpeg, formatFfmpegStatus } from "../../deps/ffmpeg.js";
import {
  registerBuiltinBackends,
  getBackend,
  listBackends,
} from "../../backends/registry.js";
import { findInputFiles, runPipeline } from "../../pipeline/orchestrator.js";
import { formatJson, formatHuman } from "../../output/formatter.js";
import { createHumanProgress, createJsonProgress } from "../../output/progress.js";
import { ExitCode } from "../../types/index.js";
import pc from "picocolors";
import { join } from "node:path";

export const transcribeCommand = new Command("transcribe")
  .description("Transcribe audio/video files using AI speech-to-text")
  .argument("<inputFolder>", "Input folder containing audio/video files")
  .argument("<outputFolder>", "Output folder for transcripts")
  .option("-m, --model <name>", "Transcription model (e.g. large-v2, medium, small)")
  .option("-d, --device <type>", "Processing device (cuda or cpu)")
  .option("-b, --backend <name>", "Transcription backend (whisper-local, whisper-api)")
  .option("--max-duration <seconds>", "Max duration before splitting (seconds)", parseInt)
  .option("--enhance", "Enable audio enhancement")
  .option("--include-temp, --keep-temp", "Keep intermediate files in <outputFolder>/temp")
  .option("--python-path <path>", "Python executable path for whisper-local backend")
  .option("--openai-api-key <key>", "OpenAI API key for whisper-api backend")
  .option("--json", "Output results as JSON (for AI agents)")
  .action(async (inputFolder: string, outputFolder: string, opts) => {
    const jsonMode = opts.json === true;

    // Build effective config from execution arguments only (stateless CLI)
    let config: Config;
    try {
      config = configSchema.parse({
        inputFolder,
        outputFolder,
        tempFolder: join(outputFolder, "temp"),
        backend: opts.backend,
        whisperModel: opts.model,
        device: opts.device,
        maxDurationSeconds: opts.maxDuration,
        enableAudioEnhancement: opts.enhance === true,
        keepIntermediateFiles: opts.includeTemp === true || opts.keepTemp === true,
        pythonPath: opts.pythonPath,
        openaiApiKey: opts.openaiApiKey,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        console.log(JSON.stringify({ error: "config_error", message: msg }));
      } else {
        console.error(pc.red(`Configuration error: ${msg}`));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    // Check FFmpeg
    const ffmpegStatus = await checkFfmpeg();
    if (!ffmpegStatus.ffmpeg.available || !ffmpegStatus.ffprobe.available) {
      if (jsonMode) {
        console.log(
          JSON.stringify({
            error: "missing_dependency",
            dependencies: ffmpegStatus,
          }),
        );
      } else {
        console.error(pc.red("\nMissing required dependencies:\n"));
        console.error(formatFfmpegStatus(ffmpegStatus));
        console.error("");
      }
      process.exit(ExitCode.MISSING_DEPENDENCY);
    }

    // Register and select backend
    registerBuiltinBackends();
    const backend = getBackend(config.backend);

    if (!backend) {
      const available = listBackends().join(", ");
      if (jsonMode) {
        console.log(
          JSON.stringify({
            error: "config_error",
            message: `Unknown backend '${config.backend}'. Available: ${available}`,
          }),
        );
      } else {
        console.error(
          pc.red(`Unknown backend '${config.backend}'. Available: ${available}`),
        );
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    backend.init(config);

    // Check backend availability
    const backendStatus = await backend.checkAvailability();
    if (!backendStatus.available) {
      if (jsonMode) {
        console.log(
          JSON.stringify({
            error: "missing_dependency",
            backend: backendStatus,
          }),
        );
      } else {
        console.error(pc.red(`\nBackend '${backend.displayName}' is not available:`));
        console.error(pc.red(`  ${backendStatus.error}`));
        if (backendStatus.installHint) {
          console.error(pc.yellow(`  ${backendStatus.installHint}`));
        }
        console.error("");
      }
      process.exit(ExitCode.MISSING_DEPENDENCY);
    }

    // Check for input files
    const inputFiles = await findInputFiles(config.inputFolder);
    if (inputFiles.length === 0) {
      if (jsonMode) {
        console.log(
          JSON.stringify({
            error: "no_input_files",
            inputFolder: config.inputFolder,
            supportedFormats: [".m4a", ".mp3", ".mp4", ".mkv", ".wav", ".flac", ".ogg", ".webm"],
          }),
        );
      } else {
        console.error(
          pc.red(`No supported audio/video files found in ${config.inputFolder}`),
        );
        console.error(
          pc.yellow("Supported formats: m4a, mp3, mp4, mkv, wav, flac, ogg, webm"),
        );
      }
      process.exit(ExitCode.NO_INPUT_FILES);
    }

    // Display config in human mode
    if (!jsonMode) {
      console.error(pc.green("\n=== Configuration ==="));
      console.error(pc.gray(`  Backend:     ${backend.displayName}`));
      console.error(pc.gray(`  Model:       ${config.whisperModel}`));
      console.error(pc.gray(`  Device:      ${config.device}`));
      console.error(pc.gray(`  Input:       ${config.inputFolder}`));
      console.error(pc.gray(`  Output:      ${config.outputFolder}`));
      console.error(pc.gray(`  Enhance:     ${config.enableAudioEnhancement}`));
      console.error(pc.gray(`  Max split:   ${config.maxDurationSeconds}s`));
      console.error("");
    }

    // Run pipeline
    const onProgress = jsonMode ? createJsonProgress() : createHumanProgress();
    const result = await runPipeline(config, backend, onProgress);

    // Output results
    if (jsonMode) {
      console.log(formatJson(result));
    } else {
      console.error(formatHuman(result));
    }

    // Exit code
    if (result.summary.failed === 0) {
      process.exit(ExitCode.SUCCESS);
    } else if (result.summary.successful > 0) {
      process.exit(ExitCode.PARTIAL_SUCCESS);
    } else {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  });
