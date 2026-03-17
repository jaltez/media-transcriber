import { Command } from "commander";
import { transcribeCommand } from "./cli/commands/transcribe.js";
import { doctorCommand } from "./cli/commands/doctor.js";

const program = new Command()
  .name("media-transcriber")
  .description(
    "Transcribe audio and video files to text and subtitles using AI speech-to-text (Whisper)",
  )
  .version("1.0.0")
  .addHelpText("after", `
Examples:
  $ media-transcriber transcribe recording.mp4           Transcribe a single file
  $ media-transcriber transcribe ./recordings ./output   Batch transcribe a folder
  $ media-transcriber doctor                             Check dependencies
`);

// Register subcommands
program.addCommand(transcribeCommand, { isDefault: true });
program.addCommand(doctorCommand);

program.parse();
