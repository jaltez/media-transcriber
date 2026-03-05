import { Command } from "commander";
import { transcribeCommand } from "./cli/commands/transcribe.js";
import { setupCommand } from "./cli/commands/setup.js";
import { configCommand } from "./cli/commands/config.js";

const program = new Command()
  .name("media-transcriber")
  .description(
    "Batch transcribe audio/video files using pluggable AI backends",
  )
  .version("1.0.0");

// Register subcommands
program.addCommand(transcribeCommand, { isDefault: true });
program.addCommand(setupCommand);
program.addCommand(configCommand);

program.parse();
