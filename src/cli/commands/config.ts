import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../../config/loader.js";
import { defaultConfig, type Config } from "../../config/schema.js";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export const configCommand = new Command("config")
  .description("Manage configuration")
  .addCommand(
    new Command("show")
      .description("Display current effective configuration")
      .option("-c, --config <path>", "Path to configuration file")
      .option("--json", "Output as JSON")
      .action(async (opts) => {
        const { config, filepath } = await loadConfig(opts.config);

        if (opts.json) {
          console.log(JSON.stringify(config, null, 2));
          return;
        }

        if (filepath) {
          console.log(pc.gray(`Loaded from: ${filepath}\n`));
        } else {
          console.log(pc.gray("No config file found, showing defaults\n"));
        }

        for (const [key, value] of Object.entries(config)) {
          console.log(`${pc.cyan(key)}: ${pc.white(String(value))}`);
        }
      }),
  )
  .addCommand(
    new Command("init")
      .description("Generate a default configuration file")
      .option("--force", "Overwrite existing config file")
      .action(async (opts) => {
        const configPath = ".media-transcriber.json";

        if (existsSync(configPath) && !opts.force) {
          console.error(
            pc.yellow(
              `${configPath} already exists. Use --force to overwrite.`,
            ),
          );
          process.exit(1);
        }

        const config: Partial<Config> = {
          backend: defaultConfig.backend,
          inputFolder: defaultConfig.inputFolder,
          outputFolder: defaultConfig.outputFolder,
          whisperModel: defaultConfig.whisperModel,
          device: defaultConfig.device,
          maxDurationSeconds: defaultConfig.maxDurationSeconds,
          enableAudioEnhancement: defaultConfig.enableAudioEnhancement,
          keepIntermediateFiles: defaultConfig.keepIntermediateFiles,
          outputFormats: defaultConfig.outputFormats,
        };

        await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        console.log(pc.green(`✓ Created ${configPath}`));
      }),
  );
