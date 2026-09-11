import { confirm, select } from "@inquirer/prompts";
import { Command } from "commander";
import { execa } from "execa";
import pc from "picocolors";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getBackend,
  listBackends,
  registerBuiltinBackends,
} from "../../backends/registry.js";
import type { TranscriptionBackend } from "../../backends/types.js";
import { configSchema, defaultConfig } from "../../config/schema.js";
import { checkCommand } from "../../deps/checker.js";
import { checkFfmpeg } from "../../deps/ffmpeg.js";
import {
  discoverLocalWhisper,
  findPythonCommand,
} from "../../deps/whisper.js";
import { discoverDeepFilterNet } from "../../deps/deepfilternet.js";
import {
  getEnhancer,
  listEnhancers,
  registerBuiltinEnhancers,
} from "../../enhancers/registry.js";
import type { AudioEnhancer } from "../../enhancers/types.js";
import { ExitCode } from "../../types/index.js";

interface InstallOption {
  id: string;
  label: string;
  command: string;
  args: string[];
  display: string;
  availabilityCommand: string;
  availabilityArgs?: string[];
  /** Optional second command to run after this one succeeds (e.g. pipx inject) */
  followUp?: InstallOption;
}

export const setupCommand = new Command("setup")
  .description("Guided setup for dependencies and backend readiness")
  .argument("[backend]", "Backend to set up", defaultConfig.backend)
  .action(async (name: string) => {
    registerBuiltinBackends();
    registerBuiltinEnhancers();

    const enhancerName = name.trim().toLowerCase();
    const enhancer = getEnhancer(enhancerName);
    if (enhancer) {
      process.exit(await runEnhancerSetup(enhancer));
    }

    const backend = getBackend(name);
    if (!backend) {
      console.error(pc.red(`Unknown backend or enhancer '${name}'.`));
      console.error(pc.gray(`Backends:   ${listBackends().join(", ")}`));
      console.error(pc.gray(`Enhancers:  ${listEnhancers().join(", ")}`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    console.log(pc.bold(`\nMedia Transcriber Setup: ${backend.displayName}\n`));

    await setupFfmpeg();

    if (backend.name === "whisper-local") {
      await setupLocalWhisper();
    } else if (backend.name === "whisper-api") {
      await setupApiBackend(backend);
    } else {
      console.log(pc.yellow(`No guided setup flow is defined for '${backend.name}'.`));
    }

    const ready = await printFinalReadiness(backend);
    if (ready) {
      await maybeRunSmokeTest(backend);
    }

    process.exit(ready ? ExitCode.SUCCESS : ExitCode.MISSING_DEPENDENCY);
  });

async function runEnhancerSetup(enhancer: AudioEnhancer): Promise<number> {
  console.log(pc.bold(`\nMedia Transcriber Setup: ${enhancer.displayName}${enhancer.experimental ? pc.yellow(" (experimental)") : ""}\n`));

  await setupFfmpeg();

  if (enhancer.name === "deepfilternet") {
    await setupDeepFilterNet();
  } else if (enhancer.name === "unise") {
    console.log("UniSE is a remote service: nothing to install locally.");
    console.log(pc.gray("It requires network access and per-run consent (--allow-upload)."));
  }

  enhancer.init(configSchema.parse({}));
  const status = await enhancer.checkAvailability();
  const ready = status.available;

  console.log("");
  if (ready) {
    console.log(pc.green(`Ready to enhance with '${enhancer.name}'${status.command ? pc.gray(` (${status.command})`) : ""}.`));
    await maybeRunEnhancerSmokeTest(enhancer);
  } else {
    console.log(pc.red(`Not ready: enhancer '${enhancer.displayName}' is not available.`));
    if (status.error) console.log(pc.red(`  ${status.error}`));
    if (status.installHint) console.log(pc.yellow(`  ${status.installHint}`));
    console.log(pc.gray(`Run 'media-transcriber doctor --enhancer ${enhancer.name}' for details.`));
  }
  console.log("");

  return ready ? ExitCode.SUCCESS : ExitCode.MISSING_DEPENDENCY;
}

async function setupDeepFilterNet(): Promise<void> {
  const status = await discoverDeepFilterNet();
  if (status.available) {
    console.log(`${pc.green("✓")} DeepFilterNet is available${status.command ? pc.gray(` (${status.command})`) : ""}`);
    return;
  }

  if (status.error?.includes("torchaudio")) {
    console.log(pc.red(status.error));
  } else {
    console.log(pc.yellow("No usable DeepFilterNet installation was found."));
  }

  const options = await availableInstallOptions(await dfnInstallOptions());
  const selected = await chooseInstallOption(
    "Choose a DeepFilterNet install path",
    options,
    dfnManualCommands(),
  );
  if (selected) {
    await runInstall(selected);
    console.log(pc.gray("If your installer changed PATH, restart the terminal before retrying if discovery still fails."));
  }
}
async function maybeRunEnhancerSmokeTest(enhancer: AudioEnhancer): Promise<void> {
  if (enhancer.requiresUpload) {
    // The smoke test runs denoise without upload consent; remote engines
    // would refuse it, and setup offers no consent flag.
    return;
  }
  if (enhancer.name === "basic") {
    // Pure ffmpeg filter; the availability check already proved ffmpeg works.
    return;
  }

  const run = await confirm({
    message: "Run an optional smoke test? This may download the model on first use.",
    default: false,
  });
  if (!run) return;

  const workDir = await mkdtemp(join(tmpdir(), "media-transcriber-enhancer-"));
  try {
    const inputFile = join(workDir, "smoke.wav");
    await execa("ffmpeg", [
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=2",
      "-f", "lavfi",
      "-i", "anoisesrc=color=pink:duration=2",
      "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first",
      "-ar", "48000",
      "-c:a", "pcm_s16le",
      "-y", inputFile,
    ], { stdio: "ignore" });

    await enhancer.denoise({ inputFile, tempFolder: workDir, allowUpload: false });
    console.log(pc.green("Smoke test completed successfully."));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`Smoke test failed: ${message}`));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function setupFfmpeg(): Promise<void> {
  const status = await checkFfmpeg();
  if (status.ffmpeg.available && status.ffprobe.available) {
    console.log(`${pc.green("✓")} FFmpeg and ffprobe are available`);
    return;
  }

  console.log(pc.yellow("FFmpeg or ffprobe is missing."));
  const options = await availableInstallOptions(ffmpegInstallOptions());
  const selected = await chooseInstallOption(
    "Choose an FFmpeg install method",
    options,
    ffmpegManualCommands(),
  );
  if (selected) {
    await runInstall(selected);
  }
}

async function setupLocalWhisper(): Promise<void> {
  const status = await discoverLocalWhisper();
  if (status.available) {
    console.log(`${pc.green("✓")} Local Whisper is available${status.command ? pc.gray(` (${status.command})`) : ""}`);
    return;
  }

  console.log(pc.yellow("No usable local Whisper installation was found."));
  const options = await availableInstallOptions(await whisperInstallOptions());
  const selected = await chooseInstallOption(
    "Choose a local Whisper install path",
    options,
    whisperManualCommands(),
  );
  if (selected) {
    await runInstall(selected);
    console.log(pc.gray("If your installer changed PATH, restart the terminal before retrying if discovery still fails."));
  }
}

async function setupApiBackend(backend: TranscriptionBackend): Promise<void> {
  const config = configSchema.parse({
    backend: backend.name,
    whisperModel: backend.defaultModel,
  });
  backend.init(config);
  const status = await backend.checkAvailability();
  if (status.available) {
    console.log(`${pc.green("✓")} OPENAI_API_KEY is visible to this process`);
    return;
  }

  console.log(pc.yellow("OpenAI API key is not configured."));
  console.log(pc.gray("Use one of these approaches; setup will not store your key:"));
  if (process.platform === "win32") {
    console.log(pc.gray("  PowerShell session: $env:OPENAI_API_KEY=\"sk-...\""));
    console.log(pc.gray("  User env var:      [Environment]::SetEnvironmentVariable(\"OPENAI_API_KEY\", \"sk-...\", \"User\")"));
  } else {
    console.log(pc.gray("  Current shell: export OPENAI_API_KEY=\"sk-...\""));
    console.log(pc.gray("  One run:       media-transcriber transcribe input.mp3 -b whisper-api --api-key sk-..."));
  }
}

async function printFinalReadiness(backend: TranscriptionBackend): Promise<boolean> {
  const ffmpeg = await checkFfmpeg();
  const config = configSchema.parse({
    backend: backend.name,
    whisperModel: backend.defaultModel,
  });
  backend.init(config);
  const backendStatus = await backend.checkAvailability();
  const ready = ffmpeg.ffmpeg.available && ffmpeg.ffprobe.available && backendStatus.available;

  console.log("");
  if (ready) {
    console.log(pc.green(`Ready to transcribe with '${backend.name}'.`));
  } else {
    console.log(pc.red(`Not ready for '${backend.name}' yet.`));
    if (!ffmpeg.ffmpeg.available) console.log(pc.red("  - ffmpeg is missing"));
    if (!ffmpeg.ffprobe.available) console.log(pc.red("  - ffprobe is missing"));
    if (!backendStatus.available) console.log(pc.red(`  - ${backend.displayName}: ${backendStatus.error ?? "not available"}`));
    console.log(pc.gray(`Run 'media-transcriber doctor --backend ${backend.name}' for details.`));
  }
  console.log("");

  return ready;
}

async function maybeRunSmokeTest(backend: TranscriptionBackend): Promise<void> {
  const run = await confirm({
    message: backend.name === "whisper-api"
      ? "Run an optional smoke test? This makes a tiny API transcription request."
      : "Run an optional smoke test? This may download the selected Whisper model.",
    default: false,
  });

  if (!run) return;

  const workDir = await mkdtemp(join(tmpdir(), "media-transcriber-setup-"));
  try {
    const inputFile = join(workDir, "smoke.mp3");
    await execa("ffmpeg", [
      "-f", "lavfi",
      "-i", "sine=frequency=1000:duration=1",
      "-ac", "1",
      "-ar", "16000",
      "-q:a", "9",
      "-y", inputFile,
    ], { stdio: "ignore" });

    const outputDir = join(workDir, "out");
    const config = configSchema.parse({
      inputFolder: workDir,
      outputFolder: outputDir,
      tempFolder: join(workDir, "temp"),
      backend: backend.name,
      whisperModel: backend.defaultModel,
      device: "auto",
      outputFormats: ["txt"],
    });
    backend.init(config);
    await backend.transcribe({
      inputFile,
      model: config.whisperModel,
      device: config.device,
      outputDir,
      outputFormats: config.outputFormats,
    });
    console.log(pc.green("Smoke test completed successfully."));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`Smoke test failed: ${message}`));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function chooseInstallOption(
  message: string,
  options: InstallOption[],
  manualCommands: string[],
): Promise<InstallOption | null> {
  if (options.length === 0) {
    printManualCommands(manualCommands);
    return null;
  }

  if (options.length === 1) {
    const option = options[0]!;
    const shouldRun = await confirm({
      message: `Run '${option.display}'?`,
      default: false,
    });
    if (!shouldRun) {
      printManualCommands(manualCommands);
      return null;
    }
    return option;
  }

  const choice = await select({
    message,
    choices: [
      ...options.map((option) => ({
        name: option.label,
        value: option.id,
        description: option.display,
      })),
      {
        name: "Print commands only",
        value: "manual",
        description: "Do not run an installer from setup",
      },
    ],
  });

  if (choice === "manual") {
    printManualCommands(manualCommands);
    return null;
  }

  const option = options.find((candidate) => candidate.id === choice) ?? null;
  if (!option) return null;

  const shouldRun = await confirm({
    message: `Run '${option.display}'?`,
    default: false,
  });

  if (!shouldRun) {
    printManualCommands(manualCommands);
    return null;
  }

  return option;
}

async function runInstall(option: InstallOption): Promise<void> {
  try {
    await execa(option.command, option.args, { stdio: "inherit" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`Installer failed: ${message}`));
    return;
  }

  if (!option.followUp) return;
  try {
    await execa(option.followUp.command, option.followUp.args, { stdio: "inherit" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`Install succeeded, but the follow-up failed: ${message}`));
    console.log(pc.yellow(`Rerun: ${option.followUp.display}`));
  }
}

async function availableInstallOptions(options: InstallOption[]): Promise<InstallOption[]> {
  const available: InstallOption[] = [];
  for (const option of options) {
    const status = await checkCommand(option.availabilityCommand, option.availabilityArgs ?? ["--version"]);
    if (status.available) {
      available.push(option);
    }
  }
  return available;
}

function ffmpegInstallOptions(): InstallOption[] {
  if (process.platform === "win32") {
    return [
      {
        id: "winget",
        label: "Install FFmpeg with winget",
        command: "winget",
        args: ["install", "--id", "Gyan.FFmpeg", "-e"],
        display: "winget install --id Gyan.FFmpeg -e",
        availabilityCommand: "winget",
      },
      {
        id: "scoop",
        label: "Install FFmpeg with Scoop",
        command: "scoop",
        args: ["install", "ffmpeg"],
        display: "scoop install ffmpeg",
        availabilityCommand: "scoop",
      },
    ];
  }

  if (process.platform === "darwin") {
    return [{
      id: "brew",
      label: "Install FFmpeg with Homebrew",
      command: "brew",
      args: ["install", "ffmpeg"],
      display: "brew install ffmpeg",
      availabilityCommand: "brew",
    }];
  }

  return [
    {
      id: "apt",
      label: "Install FFmpeg with apt",
      command: "sudo",
      args: ["apt", "install", "-y", "ffmpeg"],
      display: "sudo apt install -y ffmpeg",
      availabilityCommand: "apt",
    },
    {
      id: "dnf",
      label: "Install FFmpeg with dnf",
      command: "sudo",
      args: ["dnf", "install", "-y", "ffmpeg"],
      display: "sudo dnf install -y ffmpeg",
      availabilityCommand: "dnf",
    },
    {
      id: "pacman",
      label: "Install FFmpeg with pacman",
      command: "sudo",
      args: ["pacman", "-S", "--noconfirm", "ffmpeg"],
      display: "sudo pacman -S --noconfirm ffmpeg",
      availabilityCommand: "pacman",
    },
  ];
}

async function dfnInstallOptions(): Promise<InstallOption[]> {
  const options: InstallOption[] = [
    {
      id: "uv-tool",
      label: "Install deepfilternet with uv tool (recommended)",
      command: "uv",
      args: ["tool", "install", "deepfilternet", "--with", "torch", "--with", "torchaudio<2.9"],
      display: 'uv tool install deepfilternet --with torch --with "torchaudio<2.9"',
      availabilityCommand: "uv",
    },
    {
      id: "pipx",
      label: "Install deepfilternet with pipx",
      command: "pipx",
      args: ["install", "deepfilternet"],
      display: "pipx install deepfilternet && pipx inject deepfilternet torch \"torchaudio<2.9\"",
      availabilityCommand: "pipx",
      followUp: {
        id: "pipx-inject",
        label: "Inject torch and torchaudio into the pipx environment",
        command: "pipx",
        args: ["inject", "deepfilternet", "torch", "torchaudio<2.9"],
        display: "pipx inject deepfilternet torch \"torchaudio<2.9\"",
        availabilityCommand: "pipx",
      },
    },
  ];

  const python = await findPythonCommand();
  if (python) {
    options.push({
      id: "pip",
      label: "Install deepfilternet in active Python",
      command: python.command,
      args: [...python.args, "-m", "pip", "install", "-U", "deepfilternet", "torch", "torchaudio<2.9"],
      display: `${python.display} -m pip install -U deepfilternet torch "torchaudio<2.9"`,
      availabilityCommand: python.command,
      availabilityArgs: [...python.args, "--version"],
    });
  }

  return options;
}

function dfnManualCommands(): string[] {
  return [
    'uv tool install deepfilternet --with torch --with "torchaudio<2.9"',
    'pipx install deepfilternet && pipx inject deepfilternet torch "torchaudio<2.9"',
    'python -m pip install -U deepfilternet torch "torchaudio<2.9"',
    "# No-Python alternative: download the precompiled Rust binary from",
    "# https://github.com/Rikorose/DeepFilterNet/releases (embeds DeepFilterNet2,",
    "# no --dfn-atten support) and put it on your PATH as 'deep-filter'",
  ];
}

async function whisperInstallOptions(): Promise<InstallOption[]> {
  const options: InstallOption[] = [
    {
      id: "uv-tool",
      label: "Install openai-whisper with uv tool",
      command: "uv",
      args: ["tool", "install", "openai-whisper"],
      display: "uv tool install openai-whisper",
      availabilityCommand: "uv",
    },
    {
      id: "pipx",
      label: "Install openai-whisper with pipx",
      command: "pipx",
      args: ["install", "openai-whisper"],
      display: "pipx install openai-whisper",
      availabilityCommand: "pipx",
    },
  ];

  const python = await findPythonCommand();
  if (python) {
    options.push({
      id: "pip",
      label: "Install openai-whisper in active Python",
      command: python.command,
      args: [...python.args, "-m", "pip", "install", "-U", "openai-whisper"],
      display: `${python.display} -m pip install -U openai-whisper`,
      availabilityCommand: python.command,
      availabilityArgs: [...python.args, "--version"],
    });
  }

  return options;
}

function ffmpegManualCommands(): string[] {
  if (process.platform === "win32") {
    return ["winget install --id Gyan.FFmpeg -e", "scoop install ffmpeg"];
  }
  if (process.platform === "darwin") {
    return ["brew install ffmpeg"];
  }
  return ["sudo apt install ffmpeg", "sudo dnf install ffmpeg", "sudo pacman -S ffmpeg"];
}

function whisperManualCommands(): string[] {
  return [
    "uv tool install openai-whisper",
    "pipx install openai-whisper",
    "python -m pip install -U openai-whisper",
  ];
}

function printManualCommands(commands: string[]): void {
  console.log(pc.gray("Run one of these commands, then rerun setup or doctor:"));
  for (const command of commands) {
    console.log(pc.gray(`  ${command}`));
  }
}