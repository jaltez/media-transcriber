import { Command } from "commander";

/**
 * `media-transcriber tui` — interactive terminal UI.
 *
 * The TUI stack (@opentui/core) only loads on this subcommand, and only after
 * the runtime gate in src/tui/index.ts confirms Bun/Node+FFI support (it
 * re-execs under a capable runtime when one is available). Every other
 * command keeps its current startup cost and runtime requirements.
 */
export const tuiCommand = new Command("tui")
  .description("Interactive terminal UI (requires Bun >= 1.3.14 or Node >= 26.4 with --experimental-ffi)")
  .action(async () => {
    // Loaded dynamically so plain CLI invocations never touch OpenTUI.
    const { runTui } = await import("../../tui/index.js");
    const code = await runTui();
    // The native renderer session can keep the event loop referenced after
    // destroy; the TUI owns the terminal, so exit deterministically.
    process.exit(code);
  });
