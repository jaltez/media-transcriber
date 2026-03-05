import { Command } from "commander";
import pc from "picocolors";
import { checkFfmpeg, formatFfmpegStatus } from "../../deps/ffmpeg.js";
import {
  registerBuiltinBackends,
  getBackend,
  listBackends,
} from "../../backends/registry.js";
import { defaultConfig } from "../../config/schema.js";
import { writeFile } from "node:fs/promises";

export const setupCommand = new Command("setup")
  .description("Interactive setup wizard — check dependencies and generate config")
  .action(async () => {
    console.log(pc.green(pc.bold("\n=== Media Transcriber Setup ===\n")));

    // 1. Check FFmpeg
    console.log(pc.cyan("Checking dependencies...\n"));
    const ffmpegStatus = await checkFfmpeg();
    console.log(formatFfmpegStatus(ffmpegStatus));
    console.log("");

    if (!ffmpegStatus.ffmpeg.available || !ffmpegStatus.ffprobe.available) {
      console.log(
        pc.yellow(
          "⚠ FFmpeg is required. Please install it before running transcriptions.\n",
        ),
      );
    }

    // 2. Check backends
    registerBuiltinBackends();
    console.log(pc.cyan("Checking transcription backends...\n"));

    for (const name of listBackends()) {
      const backend = getBackend(name)!;
      backend.init(defaultConfig);
      const status = await backend.checkAvailability();

      if (status.available) {
        console.log(`  ${backend.displayName}: ${pc.green("✓ available")}`);
      } else {
        console.log(`  ${backend.displayName}: ${pc.yellow("✗ " + status.error)}`);
        if (status.installHint) {
          console.log(pc.gray(`    ${status.installHint}`));
        }
      }
    }

    console.log("");

    // 3. Interactive config generation
    let generateConfig = true;

    try {
      const { confirm } = await import("@inquirer/prompts");
      generateConfig = await confirm({
        message: "Generate a configuration file?",
        default: true,
      });
    } catch {
      // If prompts fail (non-interactive), skip
      generateConfig = false;
    }

    if (generateConfig) {
      try {
        const { select, input: inputPrompt } = await import("@inquirer/prompts");

        const backend = await select({
          message: "Transcription backend:",
          choices: listBackends().map((name) => ({
            name: getBackend(name)!.displayName,
            value: name,
          })),
        });

        const inputFolder = await inputPrompt({
          message: "Input folder:",
          default: "./data/input",
        });

        const outputFolder = await inputPrompt({
          message: "Output folder:",
          default: "./data/output",
        });

        const model = await inputPrompt({
          message: "Model:",
          default: backend === "whisper-api" ? "whisper-1" : "large-v2",
        });

        const device = await select({
          message: "Device:",
          choices: [
            { name: "CUDA (GPU)", value: "cuda" },
            { name: "CPU", value: "cpu" },
          ],
        });

        const config = {
          backend,
          inputFolder,
          outputFolder,
          whisperModel: model,
          device,
          maxDurationSeconds: 1200,
          enableAudioEnhancement: false,
          keepIntermediateFiles: false,
          outputFormats: ["txt", "srt"],
        };

        const configPath = ".media-transcriber.json";
        await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        console.log(pc.green(`\n✓ Configuration written to ${configPath}`));
        console.log(pc.gray("  Run `media-transcriber transcribe` to start.\n"));
      } catch {
        console.log(pc.yellow("\nSetup cancelled.\n"));
      }
    } else {
      console.log(
        pc.gray(
          "\nSkipped config generation. You can create .media-transcriber.json manually.\n",
        ),
      );
    }
  });
