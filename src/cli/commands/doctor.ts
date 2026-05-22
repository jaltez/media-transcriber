import { Command } from "commander";
import pc from "picocolors";
import { checkFfmpeg } from "../../deps/ffmpeg.js";
import {
  registerBuiltinBackends,
  getBackend,
  listBackends,
} from "../../backends/registry.js";
import { configSchema, defaultConfig } from "../../config/schema.js";
import { WHISPER_COMMAND_ENV } from "../../deps/whisper.js";
import type { DependencyStatus } from "../../types/index.js";
import { ExitCode } from "../../types/index.js";
import { arch, platform, version as nodeVersion } from "node:process";

interface DoctorOptions {
  backend?: string;
  apiKey?: string;
  whisperCommand?: string;
  all?: boolean;
  json?: boolean;
}

interface BackendReadiness {
  name: string;
  displayName: string;
  selected: boolean;
  available: boolean;
  version?: string;
  error?: string;
  installHint?: string;
  source?: string;
  command?: string;
  defaultModel: string;
  supportedModels: string[];
}

interface DoctorReport {
  system: {
    node: string;
    platform: string;
    arch: string;
  };
  selectedBackend: string;
  checkedAllBackends: boolean;
  dependencies: {
    ffmpeg: DependencyStatus;
    ffprobe: DependencyStatus;
  };
  backends: BackendReadiness[];
  ready: boolean;
  errors: string[];
  nextSteps: string[];
}

export const doctorCommand = new Command("doctor")
  .description("Check readiness for the default or selected transcription backend")
  .option("-b, --backend <name>", "Backend readiness path to check")
  .option("--api-key <key>", "API key for API backend readiness (env: OPENAI_API_KEY)")
  .option("--whisper-command <command>", `Local Whisper command override (env: ${WHISPER_COMMAND_ENV})`)
  .option("--all", "Show all backend availability without making optional backends fatal")
  .option("--json", "Emit machine-readable readiness output")
  .action(async (opts: DoctorOptions) => {
    registerBuiltinBackends();

    const selectedBackend = opts.backend ?? defaultConfig.backend;
    const selected = getBackend(selectedBackend);
    if (!selected) {
      const available = listBackends().join(", ");
      const message = `Unknown backend '${selectedBackend}'. Available backends: ${available}`;
      if (opts.json) {
        console.log(JSON.stringify({ error: "config_error", message }, null, 2));
      } else {
        console.error(pc.red(message));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    const ffmpegStatus = await checkFfmpeg();
    const backendNames = opts.all ? listBackends() : [selectedBackend];
    const backends: BackendReadiness[] = [];

    for (const name of backendNames) {
      const backend = getBackend(name)!;
      const config = configSchema.parse({
        backend: name,
        whisperModel: backend.defaultModel,
        openaiApiKey: opts.apiKey,
        localWhisperCommand: opts.whisperCommand ?? process.env[WHISPER_COMMAND_ENV],
      });
      backend.init(config);
      const status = await backend.checkAvailability();
      backends.push({
        name: backend.name,
        displayName: backend.displayName,
        selected: backend.name === selectedBackend,
        available: status.available,
        version: status.version,
        error: status.error,
        installHint: status.installHint,
        source: status.source,
        command: status.command,
        defaultModel: backend.defaultModel,
        supportedModels: backend.supportedModels(),
      });
    }

    const selectedStatus = backends.find((backend) => backend.name === selectedBackend)!;
    const errors: string[] = [];
    if (!ffmpegStatus.ffmpeg.available) errors.push("ffmpeg is missing");
    if (!ffmpegStatus.ffprobe.available) errors.push("ffprobe is missing");
    if (!selectedStatus.available) {
      errors.push(`${selectedStatus.displayName} is not available`);
    }

    const nextSteps = errors.length > 0
      ? [
          `Run 'media-transcriber setup ${selectedBackend}' for guided setup.`,
          `Run 'media-transcriber doctor --backend ${selectedBackend}' after setup to verify readiness.`,
        ]
      : [];

    const report: DoctorReport = {
      system: {
        node: nodeVersion,
        platform,
        arch,
      },
      selectedBackend,
      checkedAllBackends: opts.all === true,
      dependencies: ffmpegStatus,
      backends,
      ready: errors.length === 0,
      errors,
      nextSteps,
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.ready ? ExitCode.SUCCESS : ExitCode.MISSING_DEPENDENCY);
    }

    console.log(pc.bold("\nMedia Transcriber Doctor\n"));

    console.log(pc.cyan("System"));
    console.log(pc.gray(`  Node.js:  ${nodeVersion}`));
    console.log(pc.gray(`  Platform: ${platform} ${arch}`));
    console.log("");

    console.log(pc.cyan("Dependencies"));
    printDependency("ffmpeg ", ffmpegStatus.ffmpeg, true);
    printDependency("ffprobe", ffmpegStatus.ffprobe, true);
    console.log("");

    console.log(pc.cyan(opts.all ? "Backends" : "Selected Backend"));
    for (const backend of backends) {
      const marker = backend.selected ? pc.bold("*") : " ";
      if (backend.available) {
        const details = [backend.version, backend.source && `source: ${backend.source}`]
          .filter(Boolean)
          .join("; ");
        console.log(` ${marker} ${pc.green("✓")} ${backend.displayName}  ${pc.gray(details || "Available")}`);
        if (backend.command) {
          console.log(pc.gray(`      command: ${backend.command}`));
        }
      } else {
        const color = backend.selected ? pc.red : pc.yellow;
        console.log(` ${marker} ${color("✗")} ${backend.displayName}  ${color(backend.error ?? "Not available")}`);
        if (backend.installHint) {
          console.log(pc.gray(`      ${backend.installHint}`));
        }
      }
      console.log(pc.gray(`      default model: ${backend.defaultModel}`));
    }
    console.log("");

    if (report.ready) {
      console.log(pc.green(`Ready to transcribe with '${selectedBackend}'.\n`));
    } else {
      console.log(pc.red(`Not ready for '${selectedBackend}'.`));
      for (const error of errors) {
        console.log(pc.red(`  - ${error}`));
      }
      console.log("");
      for (const step of nextSteps) {
        console.log(pc.gray(step));
      }
      console.log("");
    }

    process.exit(report.ready ? ExitCode.SUCCESS : ExitCode.MISSING_DEPENDENCY);
  });

function printDependency(
  label: string,
  status: DependencyStatus,
  required: boolean,
): void {
  if (status.available) {
    console.log(`  ${pc.green("✓")} ${label}  ${pc.gray(status.version ?? "found")}`);
    return;
  }

  const color = required ? pc.red : pc.yellow;
  console.log(`  ${color("✗")} ${label}  ${color(status.error ?? "Not found")}`);
  if (status.installHint) {
    console.log(pc.gray(`    ${status.installHint}`));
  }
}
