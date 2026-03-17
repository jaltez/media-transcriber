import { Command } from "commander";
import pc from "picocolors";
import { checkFfmpeg } from "../../deps/ffmpeg.js";
import {
  registerBuiltinBackends,
  getBackend,
  listBackends,
} from "../../backends/registry.js";
import { defaultConfig } from "../../config/schema.js";
import { ExitCode } from "../../types/index.js";
import { arch, platform, version as nodeVersion } from "node:process";

export const doctorCommand = new Command("doctor")
  .description("Check system dependencies and available backends")
  .action(async () => {
    console.log(pc.bold("\nMedia Transcriber Doctor\n"));

    // System info
    console.log(pc.cyan("System"));
    console.log(pc.gray(`  Node.js:  ${nodeVersion}`));
    console.log(pc.gray(`  Platform: ${platform} ${arch}`));
    console.log("");

    let hasErrors = false;

    // Check FFmpeg
    console.log(pc.cyan("Dependencies"));
    const ffmpegStatus = await checkFfmpeg();

    if (ffmpegStatus.ffmpeg.available) {
      console.log(`  ${pc.green("✓")} ffmpeg   ${pc.gray(ffmpegStatus.ffmpeg.version ?? "")}`);
    } else {
      hasErrors = true;
      console.log(`  ${pc.red("✗")} ffmpeg   ${pc.red("Not found")}`);
      if (ffmpegStatus.ffmpeg.installHint) {
        console.log(pc.gray(`    ${ffmpegStatus.ffmpeg.installHint}`));
      }
    }

    if (ffmpegStatus.ffprobe.available) {
      console.log(`  ${pc.green("✓")} ffprobe  ${pc.gray(ffmpegStatus.ffprobe.version ?? "")}`);
    } else {
      hasErrors = true;
      console.log(`  ${pc.red("✗")} ffprobe  ${pc.red("Not found")}`);
      if (ffmpegStatus.ffprobe.installHint) {
        console.log(pc.gray(`    ${ffmpegStatus.ffprobe.installHint}`));
      }
    }
    console.log("");

    // Check backends
    registerBuiltinBackends();
    console.log(pc.cyan("Backends"));

    for (const name of listBackends()) {
      const backend = getBackend(name)!;
      backend.init(defaultConfig);
      const status = await backend.checkAvailability();

      if (status.available) {
        console.log(`  ${pc.green("✓")} ${backend.displayName}  ${pc.gray(status.version ?? "Available")}`);
      } else {
        console.log(`  ${pc.yellow("✗")} ${backend.displayName}  ${pc.yellow(status.error ?? "Not available")}`);
        if (status.installHint) {
          console.log(pc.gray(`    ${status.installHint}`));
        }
      }
    }
    console.log("");

    // Summary
    if (hasErrors) {
      console.log(pc.red("Some required dependencies are missing. Install them before running transcriptions.\n"));
      process.exit(ExitCode.MISSING_DEPENDENCY);
    } else {
      console.log(pc.green("All required dependencies are available.\n"));
    }
  });
