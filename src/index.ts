import { Command } from "commander";
import { transcribeCommand } from "./cli/commands/transcribe.js";
import { enhanceCommand } from "./cli/commands/enhance.js";
import { doctorCommand } from "./cli/commands/doctor.js";
import { setupCommand } from "./cli/commands/setup.js";
import { updateCommand } from "./cli/commands/update.js";
import { tuiCommand } from "./cli/commands/tui.js";
import { packageVersion } from "./version.js";

const program = new Command()
  .name("media-transcriber")
  .description(
    "Transcribe audio and video files to text and subtitles using AI speech-to-text (Whisper, NVIDIA Parakeet)",
  )
  .version(packageVersion)
  .addHelpText("after", `
Examples:
  $ media-transcriber transcribe recording.mp4           Transcribe a single file
  $ media-transcriber transcribe ./recordings ./output   Batch transcribe a folder
  $ media-transcriber tui                                   Interactive terminal UI
  $ media-transcriber doctor                             Check readiness
  $ media-transcriber setup whisper-local                Guided setup
  $ media-transcriber update                             Update media-transcriber
`);

// Register subcommands
program.addCommand(transcribeCommand, { isDefault: true });
program.addCommand(doctorCommand);
program.addCommand(enhanceCommand);
program.addCommand(setupCommand);
program.addCommand(updateCommand);
program.addCommand(tuiCommand);
program.parse();
