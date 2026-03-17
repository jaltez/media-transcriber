import { Command, InvalidArgumentError } from "commander";
import { configSchema, type Config } from "../../config/schema.js";
import { checkFfmpeg } from "../../deps/ffmpeg.js";
import {
  registerBuiltinBackends,
  getBackend,
  listBackends,
} from "../../backends/registry.js";
import { findInputFiles, runPipeline, runSingleFile } from "../../pipeline/orchestrator.js";
import { formatJson, formatHuman } from "../../output/formatter.js";
import { createHumanProgress, createJsonProgress, createSingleFileProgress } from "../../output/progress.js";
import { ExitCode, SUPPORTED_EXTENSIONS } from "../../types/index.js";
import pc from "picocolors";
import { join, dirname, extname } from "node:path";
import { existsSync, statSync } from "node:fs";

const SUPPORTED_FORMATS_DISPLAY = SUPPORTED_EXTENSIONS.map(e => e.slice(1)).join(", ");

interface TranscribeOptions {
  model?: string;
  device?: string;
  backend?: string;
  splitThreshold?: number;
  enhanceAudio?: boolean;
  keepTemp?: boolean;
  apiKey?: string;
  format?: string[];
  json?: boolean;
}

function parseSeconds(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Must be a positive integer (seconds).");
  }
  return parsed;
}

function parseFormats(value: string): string[] {
  const valid = ["txt", "srt"];
  const formats = value.split(",").map(f => f.trim().toLowerCase());
  for (const f of formats) {
    if (!valid.includes(f)) {
      throw new InvalidArgumentError(`Unknown format '${f}'. Valid formats: ${valid.join(", ")}`);
    }
  }
  return formats;
}

export const transcribeCommand = new Command("transcribe")
  .description("Transcribe audio/video files to text and subtitles")
  .argument("<input>", "Audio/video file or folder to transcribe")
  .argument("[output]", "Output folder (default: next to input file, required for folders)")
  .option("-m, --model <name>", "Whisper model name", "large-v2")
  .option("-d, --device <type>", "Processing device", "cuda")
  .option("-b, --backend <name>", "Transcription backend", "whisper-local")
  .option("--split-threshold <seconds>", "Split files longer than this duration", parseSeconds)
  .option("--enhance-audio", "Apply noise reduction and audio enhancement")
  .option("--keep-temp", "Keep intermediate files in output/temp folder")
  .option("--api-key <key>", "API key for the backend (env: OPENAI_API_KEY)", process.env["OPENAI_API_KEY"])
  .option("-f, --format <formats>", "Output formats, comma-separated: txt, srt", parseFormats)
  .option("--json", "Machine-readable JSON output for scripts and AI agents")
  .addHelpText("after", `
Supported input formats:
  ${SUPPORTED_FORMATS_DISPLAY}

Examples:
  $ media-transcriber transcribe recording.mp4              Transcribe a single file
  $ media-transcriber transcribe meeting.mp4 ./out          Single file to specific folder
  $ media-transcriber transcribe ./recordings ./output      Batch transcribe a folder
  $ media-transcriber transcribe ./in ./out -b whisper-api  Use OpenAI Whisper API
  $ media-transcriber transcribe ./in ./out --model small   Use a faster model
  $ media-transcriber transcribe ./in ./out -f srt          Output only SRT subtitles
  $ media-transcriber doctor                                Check dependencies
`)
  .action(async (input: string, output: string | undefined, opts: TranscribeOptions) => {
    const jsonMode = opts.json === true;

    // Resolve input: file or directory?
    if (!existsSync(input)) {
      const msg = `Input path does not exist: '${input}'`;
      if (jsonMode) {
        console.log(JSON.stringify({ error: "input_not_found", message: msg }));
      } else {
        console.error(pc.red(msg));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    const inputStat = statSync(input);
    const isSingleFile = inputStat.isFile();

    // Validate single-file extension
    if (isSingleFile) {
      const ext = extname(input).toLowerCase();
      if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
        const msg = `Unsupported file format '${ext}'.\nSupported formats: ${SUPPORTED_FORMATS_DISPLAY}`;
        if (jsonMode) {
          console.log(JSON.stringify({ error: "unsupported_format", message: msg }));
        } else {
          console.error(pc.red(msg));
        }
        process.exit(ExitCode.CONFIG_ERROR);
      }
    }

    // Resolve output folder
    const outputFolder = output
      ? output
      : isSingleFile
        ? dirname(input)
        : null;

    if (!outputFolder) {
      const msg = "Output folder is required when transcribing a directory.\n"
        + pc.gray("Usage: media-transcriber transcribe <folder> <output>");
      if (jsonMode) {
        console.log(JSON.stringify({ error: "missing_output", message: "Output folder is required when transcribing a directory." }));
      } else {
        console.error(pc.red(msg));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    // Build config
    const inputFolder = isSingleFile ? dirname(input) : input;
    const outputFormats = opts.format ?? ["txt", "srt"];

    let config: Config;
    try {
      config = configSchema.parse({
        inputFolder,
        outputFolder,
        tempFolder: join(outputFolder, "temp"),
        backend: opts.backend,
        whisperModel: opts.model,
        device: opts.device,
        maxDurationSeconds: opts.splitThreshold,
        enableAudioEnhancement: opts.enhanceAudio === true,
        keepIntermediateFiles: opts.keepTemp === true,
        openaiApiKey: opts.apiKey,
        outputFormats,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        console.log(JSON.stringify({ error: "config_error", message: msg }));
      } else {
        console.error(pc.red(`Invalid configuration: ${msg}`));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    // Check FFmpeg
    const ffmpegStatus = await checkFfmpeg();
    if (!ffmpegStatus.ffmpeg.available || !ffmpegStatus.ffprobe.available) {
      if (jsonMode) {
        console.log(JSON.stringify({ error: "missing_dependency", dependencies: ffmpegStatus }));
      } else {
        console.error(pc.red("\nFFmpeg is required but not installed."));
        if (!ffmpegStatus.ffmpeg.available && ffmpegStatus.ffmpeg.installHint) {
          console.error(pc.yellow(`  ${ffmpegStatus.ffmpeg.installHint}`));
        }
        if (!ffmpegStatus.ffprobe.available && ffmpegStatus.ffprobe.installHint) {
          console.error(pc.yellow(`  ${ffmpegStatus.ffprobe.installHint}`));
        }
        console.error(pc.gray("\nRun 'media-transcriber doctor' for detailed diagnostics.\n"));
      }
      process.exit(ExitCode.MISSING_DEPENDENCY);
    }

    // Register and select backend
    registerBuiltinBackends();
    const backend = getBackend(config.backend);

    if (!backend) {
      const available = listBackends().join(", ");
      const msg = `Unknown backend '${config.backend}'.\nAvailable backends: ${available}\nRun 'media-transcriber doctor' to check backend availability.`;
      if (jsonMode) {
        console.log(JSON.stringify({ error: "config_error", message: `Unknown backend '${config.backend}'. Available: ${available}` }));
      } else {
        console.error(pc.red(msg));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    backend.init(config);

    // Check backend availability
    const backendStatus = await backend.checkAvailability();
    if (!backendStatus.available) {
      if (jsonMode) {
        console.log(JSON.stringify({ error: "missing_dependency", backend: backendStatus }));
      } else {
        console.error(pc.red(`\nBackend '${backend.displayName}' is not available: ${backendStatus.error}`));
        if (backendStatus.installHint) {
          console.error(pc.yellow(`  ${backendStatus.installHint}`));
        }
        console.error(pc.gray("\nRun 'media-transcriber doctor' for detailed diagnostics.\n"));
      }
      process.exit(ExitCode.MISSING_DEPENDENCY);
    }

    // --- Single file mode ---
    if (isSingleFile) {
      if (!jsonMode) {
        console.error(pc.green(`\n=== Configuration ===`));
        console.error(pc.gray(`  Backend:   ${backend.displayName}`));
        console.error(pc.gray(`  Model:     ${config.whisperModel}`));
        console.error(pc.gray(`  Device:    ${config.device}`));
        console.error(pc.gray(`  Input:     ${input}`));
        console.error(pc.gray(`  Output:    ${outputFolder}`));
        console.error(pc.gray(`  Formats:   ${outputFormats.join(", ")}`));
        if (config.enableAudioEnhancement) {
          console.error(pc.gray(`  Enhance:   yes`));
        }
      }

      const startTime = Date.now();
      const onProgress = jsonMode ? createJsonProgress() : createSingleFileProgress();
      const result = await runSingleFile(input, config, backend, onProgress);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (jsonMode) {
        console.log(formatJson({ files: [result], summary: { totalFiles: 1, successful: result.success ? 1 : 0, failed: result.success ? 0 : 1, elapsed: Date.now() - startTime } }));
      } else if (result.success) {
        const outputs = [result.output.txt, result.output.srt].filter(Boolean).join(", ");
        console.error(pc.green(`\n✓ Transcription complete → ${outputs} (${elapsed}s)\n`));
      } else {
        console.error(pc.red(`\n✗ Transcription failed: ${result.error}\n`));
      }

      process.exit(result.success ? ExitCode.SUCCESS : ExitCode.GENERAL_ERROR);
    }

    // --- Batch mode ---

    // Check for input files
    const inputFiles = await findInputFiles(config.inputFolder);
    if (inputFiles.length === 0) {
      if (jsonMode) {
        console.log(JSON.stringify({
          error: "no_input_files",
          inputFolder: config.inputFolder,
          supportedFormats: SUPPORTED_EXTENSIONS,
        }));
      } else {
        console.error(pc.red(`No audio or video files found in '${config.inputFolder}'`));
        console.error(pc.yellow(`Supported formats: ${SUPPORTED_FORMATS_DISPLAY}`));
        console.error(pc.gray("\nRun 'media-transcriber doctor' to verify your setup.\n"));
      }
      process.exit(ExitCode.NO_INPUT_FILES);
    }

    // Display config
    if (!jsonMode) {
      console.error(pc.green("\n=== Configuration ==="));
      console.error(pc.gray(`  Backend:   ${backend.displayName}`));
      console.error(pc.gray(`  Model:     ${config.whisperModel}`));
      console.error(pc.gray(`  Device:    ${config.device}`));
      console.error(pc.gray(`  Input:     ${config.inputFolder}`));
      console.error(pc.gray(`  Output:    ${config.outputFolder}`));
      console.error(pc.gray(`  Formats:   ${outputFormats.join(", ")}`));
      if (config.enableAudioEnhancement) {
        console.error(pc.gray(`  Enhance:   yes`));
      }
      console.error(pc.gray(`  Split at:  ${config.maxDurationSeconds}s`));
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
