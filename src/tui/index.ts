import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ExitCode } from "../types/index.js";

/**
 * Entry for the TUI subcommand. OpenTUI's native core requires Bun >= 1.3.14
 * or Node >= 26.4 with --experimental-ffi. This gate keeps every other
 * subcommand unaffected: it only runs for `tui`, re-executes under a capable
 * runtime when available, and fails gracefully otherwise.
 */

const BUN_MIN = [1, 3, 14];
const NODE_MIN = [26, 4, 0];

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function atLeast(version: string, min: number[]): boolean {
  const parts = versionParts(version);
  for (let i = 0; i < min.length; i++) {
    const actual = parts[i] ?? 0;
    if (actual > min[i]!) return true;
    if (actual < min[i]!) return false;
  }
  return true;
}

function findBun(): string | null {
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const candidate = `${dir}${dir.endsWith("/") ? "" : "/"}${exe}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function respawn(runtime: string, runtimeArgs: string[]): number {
  const entry = process.argv[1]!;
  const result = spawnSync(runtime, [...runtimeArgs, entry, "tui"], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`Failed to re-exec under ${runtime}: ${result.error.message}`);
    return ExitCode.GENERAL_ERROR;
  }
  return result.status ?? ExitCode.GENERAL_ERROR;
}

const INCOMPATIBLE_MESSAGE = `
The interactive TUI requires a runtime with OpenTUI native support:
  • Bun >= 1.3.14            (recommended: bun install -y bun; or https://bun.sh)
  • Node.js >= 26.4 with --experimental-ffi

Every other media-transcriber command works on your current runtime.
`.trim();

export async function runTui(): Promise<number> {
  const bunVersion = process.versions.bun;

  if (bunVersion) {
    if (!atLeast(bunVersion, BUN_MIN)) {
      const bun = findBun();
      if (bun) return respawn(bun, []);
      console.error(INCOMPATIBLE_MESSAGE);
      return ExitCode.MISSING_DEPENDENCY;
    }
    return launchApp();
  }

  const nodeVersion = process.versions.node;
  if (atLeast(nodeVersion, NODE_MIN)) {
    const hasFfiFlag = process.execArgv.some((arg) => arg.includes("experimental-ffi"));
    if (!hasFfiFlag) {
      return respawn(process.execPath, ["--experimental-ffi"]);
    }
    return launchApp();
  }

  const bun = findBun();
  if (bun) return respawn(bun, []);
  console.error(INCOMPATIBLE_MESSAGE);
  return ExitCode.MISSING_DEPENDENCY;
}

async function launchApp(): Promise<number> {
  try {
    const { runTuiApp } = await import("./app.js");
    return await runTuiApp();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("opentui") || message.includes("native") || message.includes("ffi")) {
      console.error(`OpenTUI failed to load on this platform: ${message}`);
      console.error("The TUI needs @opentui/core's native package for your platform.");
      return ExitCode.MISSING_DEPENDENCY;
    }
    throw err;
  }
}
