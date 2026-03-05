import ora, { type Ora } from "ora";
import pc from "picocolors";
import type { ProgressEvent, PipelineStep } from "../types/index.js";
import { formatProgressJson } from "./formatter.js";

const stepLabels: Record<PipelineStep, string> = {
  convert: "Converting to MP3",
  check_duration: "Checking duration",
  split: "Splitting audio",
  enhance: "Enhancing audio",
  transcribe: "Transcribing",
  merge: "Merging transcripts",
  copy_output: "Copying output",
};

/**
 * Creates a progress callback for human-friendly terminal output with spinners.
 */
export function createHumanProgress(): (event: ProgressEvent) => void {
  let spinner: Ora | null = null;

  return (event: ProgressEvent) => {
    switch (event.event) {
      case "batch_start":
        console.error(
          pc.cyan(`\nFound ${event.totalFiles} file(s) to process\n`),
        );
        break;

      case "file_start":
        spinner?.stop();
        console.error(
          pc.green(
            `[${event.fileNumber}/${event.totalFiles}] Processing: ${event.file}`,
          ),
        );
        console.error("=".repeat(70));
        break;

      case "step_start":
        spinner = ora({
          text: stepLabels[event.step] ?? event.step,
          stream: process.stderr,
        }).start();
        break;

      case "step_complete":
        spinner?.succeed(stepLabels[event.step] ?? event.step);
        spinner = null;
        break;

      case "file_complete":
        spinner?.stop();
        if (event.success) {
          console.error(pc.green(`  ✓ Complete\n`));
        } else {
          console.error(pc.red(`  ✗ ERROR: ${event.error}\n`));
        }
        break;

      case "batch_complete":
        // Handled by formatHuman in the main command
        break;
    }
  };
}

/**
 * Creates a progress callback that emits NDJSON events to stderr (for AI agents).
 */
export function createJsonProgress(): (event: ProgressEvent) => void {
  return (event: ProgressEvent) => {
    process.stderr.write(formatProgressJson(event) + "\n");
  };
}
