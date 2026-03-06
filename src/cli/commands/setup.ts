import { Command } from "commander";
import pc from "picocolors";
import { checkFfmpeg, formatFfmpegStatus } from "../../deps/ffmpeg.js";
import {
  registerBuiltinBackends,
  getBackend,
  listBackends,
} from "../../backends/registry.js";
import { defaultConfig } from "../../config/schema.js";

export const setupCommand = new Command("setup")
  .description("Dependency check wizard for stateless CLI usage")
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

    console.log(pc.cyan("Stateless usage examples:\n"));
    console.log(pc.gray("  media-transcriber transcribe ./input ./output"));
    console.log(pc.gray("  media-transcriber transcribe ./input ./output --backend whisper-api --openai-api-key <key>"));
    console.log(pc.gray("  media-transcriber transcribe ./input ./output --backend whisper-local --python-path .\\.venv\\Scripts\\python.exe"));
    console.log(pc.gray("  media-transcriber transcribe ./input ./output --include-temp\n"));
  });
