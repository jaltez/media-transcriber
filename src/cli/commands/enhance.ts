import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { configSchema } from "../../config/schema.js";
import { checkFfmpeg } from "../../deps/ffmpeg.js";
import {
  getEnhancer,
  listEnhancers,
  registerBuiltinEnhancers,
} from "../../enhancers/registry.js";
import { runEnhancement } from "../../enhancers/chain.js";
import type { EnhancementReport } from "../../types/index.js";
import { ExitCode, SUPPORTED_EXTENSIONS } from "../../types/index.js";
import { findInputFiles } from "../../pipeline/orchestrator.js";

const SUPPORTED_FORMATS_DISPLAY = SUPPORTED_EXTENSIONS.map(e => e.slice(1)).join(", ");

interface EnhanceCommandOptions {
  enhancer?: string;
  enhanceProfile?: "asr" | "master";
  declick?: boolean;
  humNotch?: boolean;
  howlNotch?: boolean;
  dfnAtten?: number;
  allowUpload?: boolean;
  report?: boolean;
  json?: boolean;
}

interface EnhanceFileResult {
  input: string;
  output: string | null;
  success: boolean;
  error?: string;
  enhancement?: EnhancementReport;
}

function parseAttenDb(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 40) {
    throw new InvalidArgumentError("Must be an integer between 0 and 40 (dB).");
  }
  return parsed;
}

function parseProfile(value: string): "asr" | "master" {
  const profile = value.trim().toLowerCase();
  if (profile !== "asr" && profile !== "master") {
    throw new InvalidArgumentError("Unknown enhancement profile. Valid profiles: asr, master");
  }
  return profile;
}

/**
 * Standalone audio enhancement: audition the enhancement chain or produce
 * cleaned audio for archival, without transcribing. Default profile is
 * "master" (includes dynamics + loudness conditioning); use --enhance-profile
 * asr for a lighter chain aimed at transcription input.
 */
export const enhanceCommand = new Command("enhance")
  .description("Enhance audio with noise/hum reduction (audition or standalone use)")
  .argument("<input>", "Audio/video file or folder to enhance")
  .argument("[output]", "Output folder (default: next to input file, required for folders)")
  .option("--enhancer <name>", "Enhancement engine: basic, deepfilternet, unise", "basic")
  .option("--enhance-profile <profile>", "Post-processing: asr (light) or master (listening grade)", parseProfile, "master")
  .option("--declick", "Add declicking to the enhancement chain")
  .option("--no-hum-notch", "Skip mains-hum analysis and notch filtering")
  .option("--howl-notch", "Also notch sustained feedback howls")
  .option("--dfn-atten <dB>", "DeepFilterNet attenuation limit in dB", parseAttenDb)
  .option("--allow-upload", "Consent to upload audio for remote enhancement engines (env: MEDIA_TRANSCRIBER_ALLOW_UPLOAD)")
  .option("--report", "Write <name>_enhancement.json next to each output")
  .option("--json", "Machine-readable JSON output for scripts and AI agents")
  .addHelpText("after", `
Supported input formats:
  ${SUPPORTED_FORMATS_DISPLAY}

Examples:
  $ media-transcriber enhance interview.wav                    Enhanced WAV next to the input
  $ media-transcriber enhance ./cassettes ./out --enhancer deepfilternet
  $ media-transcriber enhance in.wav --report                  Also write an enhancement report
  $ media-transcriber doctor --enhancer deepfilternet          Check enhancer readiness
`)
  .action(async (input: string, output: string | undefined, opts: EnhanceCommandOptions) => {
    const jsonMode = opts.json === true;
    const fail = (error: string, message: string, exitCode: number, extra?: Record<string, unknown>): never => {
      if (jsonMode) {
        console.log(JSON.stringify({ error, message, ...extra }));
      } else {
        console.error(pc.red(message));
      }
      process.exit(exitCode);
    };

    // Resolve input/output (mirrors transcribe's file-vs-folder handling)
    if (!existsSync(input)) {
      fail("input_not_found", `Input path does not exist: '${input}'`, ExitCode.CONFIG_ERROR);
    }

    const isSingleFile = statSync(input).isFile();
    if (isSingleFile) {
      const ext = extname(input).toLowerCase();
      if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
        fail("unsupported_format", `Unsupported file format '${ext}'.\nSupported formats: ${SUPPORTED_FORMATS_DISPLAY}`, ExitCode.CONFIG_ERROR);
      }
    }

    const outputFolder = output ?? (isSingleFile ? dirname(input) : null);
    if (!outputFolder) {
      const msg = "Output folder is required when enhancing a directory.\n" + pc.gray("Usage: media-transcriber enhance <folder> <output>");
      if (jsonMode) {
        console.log(JSON.stringify({ error: "missing_output", message: "Output folder is required when enhancing a directory." }));
      } else {
        console.error(pc.red(msg));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    // Preflight: ffmpeg + enhancer
    const ffmpegStatus = await checkFfmpeg();
    if (!ffmpegStatus.ffmpeg.available || !ffmpegStatus.ffprobe.available) {
      fail("missing_dependency", "FFmpeg and ffprobe are required for enhancement.", ExitCode.MISSING_DEPENDENCY, { dependencies: ffmpegStatus });
    }

    registerBuiltinEnhancers();
    const enhancerName = (opts.enhancer ?? "basic").trim().toLowerCase();
    const enhancer = getEnhancer(enhancerName);
    if (!enhancer) {
      const available = listEnhancers().join(", ");
      if (jsonMode) {
        console.log(JSON.stringify({ error: "config_error", message: `Unknown enhancer '${enhancerName}'. Available: ${available}` }));
      } else {
        console.error(pc.red(`Unknown enhancer '${enhancerName}'. Available enhancers: ${available}`));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    const allowUpload = opts.allowUpload === true || process.env["MEDIA_TRANSCRIBER_ALLOW_UPLOAD"] === "1";
    if (enhancer.requiresUpload && !allowUpload) {
      fail(
        "config_error",
        `Enhancer '${enhancer.displayName}' uploads audio to a remote service. Pass --allow-upload (or set MEDIA_TRANSCRIBER_ALLOW_UPLOAD=1) to consent.`,
        ExitCode.CONFIG_ERROR,
      );
    }

    const config = configSchema.parse({
      enhancer: enhancerName,
      enhanceProfile: opts.enhanceProfile ?? "master",
      enhanceOptions: {
        declick: opts.declick === true,
        humNotch: opts.humNotch !== false,
        howlNotch: opts.howlNotch === true,
        dfnAttenLimDb: opts.dfnAtten,
      },
      allowUpload,
    });

    enhancer.init(config);
    const enhancerStatus = await enhancer.checkAvailability();
    if (!enhancerStatus.available) {
      if (jsonMode) {
        console.log(JSON.stringify({ error: "missing_dependency", enhancer: enhancerStatus }));
      } else {
        console.error(pc.red(`\nEnhancer '${enhancer.displayName}' is not available: ${enhancerStatus.error}`));
        if (enhancerStatus.installHint) {
          console.error(pc.yellow(`  ${enhancerStatus.installHint}`));
        }
        console.error(pc.gray(`\nRun 'media-transcriber setup ${enhancer.name}' for guided setup, or 'media-transcriber doctor --enhancer ${enhancer.name}' for detailed diagnostics.\n`));
      }
      process.exit(ExitCode.MISSING_DEPENDENCY);
    }

    // Collect files
    const inputFiles = isSingleFile ? [input] : await findInputFiles(input);
    if (inputFiles.length === 0) {
      fail("no_input_files", `No audio or video files found in '${input}'`, ExitCode.NO_INPUT_FILES, { supportedFormats: SUPPORTED_EXTENSIONS });
    }

    if (!jsonMode) {
      console.error(pc.green(`\n=== Enhancement ===`));
      console.error(pc.gray(`  Engine:    ${enhancer.displayName}${enhancer.experimental ? pc.yellow(" (experimental)") : ""}`));
      console.error(pc.gray(`  Profile:   ${config.enhanceProfile}`));
      console.error(pc.gray(`  Input:     ${input}`));
      console.error(pc.gray(`  Output:    ${outputFolder}`));
      console.error(pc.gray(`  Files:     ${inputFiles.length}`));
      if (enhancer.requiresUpload) {
        console.error(pc.yellow(`  Note:      audio will be uploaded to ${enhancer.displayName}`));
      }
      console.error("");
    }

    // Run
    const startTime = Date.now();
    const results: EnhanceFileResult[] = [];
    const tempFolder = join(outputFolder, "temp");

    for (let i = 0; i < inputFiles.length; i++) {
      const filePath = inputFiles[i]!;
      const baseName = basename(filePath, extname(filePath));

      if (!jsonMode) {
        console.error(pc.cyan(`[${i + 1}/${inputFiles.length}] ${basename(filePath)}`));
      }

      try {
        const { outputFile, report } = await runEnhancement({
          inputFile: filePath,
          outputFolder: tempFolder,
          baseName,
          enhancer,
          options: {
            profile: config.enhanceProfile,
            declick: config.enhanceOptions.declick,
            humNotch: config.enhanceOptions.humNotch,
            howlNotch: config.enhanceOptions.howlNotch,
            loudnessTargetLufs: config.enhanceOptions.loudnessTargetLufs,
            attenLimDb: config.enhanceOptions.dfnAttenLimDb,
            allowUpload: config.allowUpload,
          },
          outputExt: ".wav",
          onProgress: (percent, message) => {
            if (!jsonMode && message) {
              console.error(pc.gray(`    ${message}`));
            } else if (!jsonMode) {
              console.error(pc.gray(`    ${percent}%`));
            }
          },
        });

        // Move the product from temp to the output folder
        await mkdir(outputFolder, { recursive: true });
        const finalOutput = join(outputFolder, `${baseName}_enhanced.wav`);
        await rename(outputFile, finalOutput);

        if (opts.report) {
          const reportFile = join(outputFolder, `${baseName}_enhancement.json`);
          await writeFile(reportFile, JSON.stringify({ ...report, outputFile: finalOutput }, null, 2));
          if (!jsonMode) {
            console.error(pc.gray(`    report:   ${reportFile}`));
          }
        }

        if (!jsonMode) {
          const notches = [
            ...report.analysis.humNotches.map(n => `${n.freq.toFixed(1)}Hz`),
            ...report.analysis.howlNotches.map(n => `${n.freq.toFixed(1)}Hz`),
          ];
          const loudness = report.loudness?.afterLufs !== undefined && report.loudness.afterLufs !== null
            ? `, ${report.loudness.afterLufs.toFixed(1)} LUFS`
            : "";
          console.error(pc.green(`    done: ${finalOutput}${notches.length > 0 ? `, notched ${notches.join(", ")}` : ""}${loudness}`));
        }

        results.push({ input: filePath, output: finalOutput, success: true, enhancement: { ...report, outputFile: finalOutput } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!jsonMode) {
          console.error(pc.red(`    failed: ${message}`));
        }
        results.push({ input: filePath, output: null, success: false, error: message });
      }
    }

    // Remove temp intermediates when every file succeeded
    if (results.every(r => r.success) && existsSync(tempFolder)) {
      await rm(tempFolder, { recursive: true, force: true });
    }

    const elapsed = Date.now() - startTime;
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    if (jsonMode) {
      console.log(JSON.stringify({
        files: results,
        summary: { totalFiles: results.length, successful, failed, elapsed },
      }, null, 2));
    } else {
      console.error("");
      if (failed === 0) {
        console.error(pc.green(`Enhanced ${successful} file(s) in ${(elapsed / 1000).toFixed(1)}s → ${outputFolder}\n`));
      } else {
        console.error(pc.red(`Completed with ${failed} failure(s) out of ${results.length} file(s).\n`));
      }
    }

    if (failed === 0) {
      process.exit(ExitCode.SUCCESS);
    } else if (successful > 0) {
      process.exit(ExitCode.PARTIAL_SUCCESS);
    }
    process.exit(ExitCode.GENERAL_ERROR);
  });
