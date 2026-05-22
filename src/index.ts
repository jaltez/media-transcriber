import { Command } from "commander";
import { transcribeCommand } from "./cli/commands/transcribe.js";
import { doctorCommand } from "./cli/commands/doctor.js";
import { setupCommand } from "./cli/commands/setup.js";
import { packageVersion } from "./version.js";

const program = new Command()
  .name("media-transcriber")
  .description(
    "Transcribe audio and video files to text and subtitles using AI speech-to-text (Whisper)",
  )
  .version(packageVersion)
  .addHelpText("after", `
Examples:
  $ media-transcriber transcribe recording.mp4           Transcribe a single file
  $ media-transcriber transcribe ./recordings ./output   Batch transcribe a folder
  $ media-transcriber doctor                             Check readiness
  $ media-transcriber setup whisper-local                Guided setup
`);

// Register subcommands
program.addCommand(transcribeCommand, { isDefault: true });
program.addCommand(doctorCommand);
program.addCommand(setupCommand);

program.parse();
