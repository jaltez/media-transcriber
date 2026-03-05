import pc from "picocolors";
import type { BatchResult, ProgressEvent } from "../types/index.js";

/**
 * Format batch results as structured JSON for agent consumption.
 */
export function formatJson(result: BatchResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format batch results as human-readable text.
 */
export function formatHuman(result: BatchResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("=".repeat(70));
  lines.push(pc.green(pc.bold("=== Processing Complete ===")));
  lines.push("=".repeat(70));
  lines.push(`${pc.cyan("Total files:")}  ${result.summary.totalFiles}`);
  lines.push(`${pc.green("Successful:")}   ${result.summary.successful}`);

  if (result.summary.failed > 0) {
    lines.push(`${pc.red("Failed:")}       ${result.summary.failed}`);
    lines.push("");
    lines.push(pc.red("Failed files:"));
    for (const file of result.files.filter((f) => !f.success)) {
      lines.push(pc.red(`  - ${file.input}: ${file.error ?? "unknown error"}`));
    }
  } else {
    lines.push(`${pc.gray("Failed:")}       0`);
  }

  const elapsed = (result.summary.elapsed / 1000).toFixed(1);
  lines.push(`\n${pc.cyan("Elapsed:")}      ${elapsed}s`);

  const outputDir = result.files.find((f) => f.output.txt)?.output.txt;
  if (outputDir) {
    const dir = outputDir.substring(0, outputDir.lastIndexOf("/") + 1) || outputDir.substring(0, outputDir.lastIndexOf("\\") + 1);
    lines.push(`${pc.cyan("Output:")}       ${dir}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format a progress event as an NDJSON line for stderr (agent mode).
 */
export function formatProgressJson(event: ProgressEvent): string {
  return JSON.stringify(event);
}
