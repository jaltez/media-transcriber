import { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import { execa } from "execa";
import pc from "picocolors";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../../version.js";
import { ExitCode } from "../../types/index.js";

const PACKAGE_NAME = "media-transcriber";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export type InstallContext = "npx" | "npm-global" | "git" | "unknown";

/**
 * Compare two dotted version strings. Returns > 0 when a is newer, < 0 when
 * b is newer, 0 when equal. Non-numeric parts fall back to 0, which is fine
 * for dist-tags: npm's `latest` always points at a stable release.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^[v=]/, "").split(".");
  const pb = b.replace(/^[v=]/, "").split(".");
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function segmentsOf(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter(Boolean);
}

/**
 * Classify how this copy of media-transcriber was installed, from the path
 * of the executing dist/index.js. `gitRootPresent` reports whether a
 * directory contains a `.git` entry (injected so this stays testable).
 */
export function detectInstallContext(
  execPath: string,
  npmGlobalRoot: string | null,
  gitRootPresent: (dir: string) => boolean,
): InstallContext {
  if (segmentsOf(execPath).includes("_npx")) {
    return "npx";
  }

  if (npmGlobalRoot && isAbsolute(npmGlobalRoot)) {
    const rel = relative(resolve(npmGlobalRoot), resolve(execPath));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return "npm-global";
    }
  }

  let dir = dirname(resolve(execPath));
  while (true) {
    if (gitRootPresent(dir)) {
      return "git";
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return "unknown";
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { version?: string };
    return typeof payload.version === "string" ? payload.version : null;
  } catch {
    return null;
  }
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const result = await execa("npm", ["root", "-g"], {
      timeout: 15_000,
      reject: false,
      shell: process.platform === "win32",
    });
    const root = result.stdout.trim();
    return result.exitCode === 0 && root ? root : null;
  } catch {
    return null;
  }
}

function hasGitEntry(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function printManualCommands(): void {
  console.log(pc.gray("Update manually with one of:"));
  console.log(pc.gray(`  npm install -g ${PACKAGE_NAME}@latest`));
  console.log(pc.gray(`  npx ${PACKAGE_NAME}@latest`));
}

export const updateCommand = new Command("update")
  .description("Update media-transcriber to the latest published version")
  .option("--check", "Only check for a new version without installing")
  .option("-y, --yes", "Skip the confirmation prompt")
  .addHelpText("after", `
Examples:
  $ media-transcriber update            Install the latest version
  $ media-transcriber update --check    Only report whether a new version exists
`)
  .action(async (opts: { check?: boolean; yes?: boolean }) => {
    console.log(pc.bold(`\nmedia-transcriber update (current: v${packageVersion})\n`));

    const latest = await fetchLatestVersion();
    if (!latest) {
      console.error(pc.red("Could not reach the npm registry to check the latest version."));
      printManualCommands();
      console.error("");
      process.exit(ExitCode.GENERAL_ERROR);
    }

    const comparison = compareSemver(latest, packageVersion);
    if (comparison === 0) {
      console.log(pc.green(`Already up to date (v${packageVersion} is the latest published version).\n`));
      process.exit(ExitCode.SUCCESS);
    }
    if (comparison < 0) {
      console.log(pc.green(`You are running v${packageVersion}, which is newer than the latest published version (v${latest}).\n`));
      process.exit(ExitCode.SUCCESS);
    }

    console.log(`Update available: v${packageVersion} → v${pc.green(latest)}`);
    console.log("");

    const execPath = fileURLToPath(import.meta.url);
    const context = detectInstallContext(execPath, await getNpmGlobalRoot(), hasGitEntry);

    if (opts.check) {
      console.log(pc.gray("Run 'media-transcriber update' to install it."));
      console.log("");
      process.exit(ExitCode.SUCCESS);
    }

    if (context === "npx") {
      console.log(pc.yellow("This copy was run from the npx cache, which does not update itself."));
      console.log(pc.gray(`Use 'npx ${PACKAGE_NAME}@latest' for a one-off run, or install globally:`));
      console.log(pc.gray(`  npm install -g ${PACKAGE_NAME}`));
      console.log("");
      process.exit(ExitCode.SUCCESS);
    }

    if (context === "git") {
      console.log(pc.yellow("This copy comes from a git checkout; update it with git:"));
      console.log(pc.gray("  git pull && npm install && npm run build"));
      console.log("");
      process.exit(ExitCode.SUCCESS);
    }

    if (context === "npm-global") {
      const interactive = process.stdin.isTTY === true;
      if (!opts.yes && !interactive) {
        console.log(pc.yellow("Non-interactive session: skipping the installer."));
        printManualCommands();
        console.log("");
        process.exit(ExitCode.SUCCESS);
      }
      if (!opts.yes) {
        const proceed = await confirm({
          message: `Install ${PACKAGE_NAME}@${latest} globally with npm?`,
          default: true,
        });
        if (!proceed) {
          printManualCommands();
          console.log("");
          process.exit(ExitCode.SUCCESS);
        }
      }

      try {
        await execa("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], {
          stdio: "inherit",
          shell: process.platform === "win32",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`npm install failed: ${message}`));
        printManualCommands();
        console.error("");
        process.exit(ExitCode.GENERAL_ERROR);
      }

      console.log(pc.green(`\nUpdated to ${PACKAGE_NAME}@${latest}.`));
      console.log(pc.gray("If the version did not change yet, restart your terminal so PATH resolves the new install.\n"));
      process.exit(ExitCode.SUCCESS);
    }

    console.log(pc.yellow("Could not determine how this copy was installed."));
    printManualCommands();
    console.log("");
    process.exit(ExitCode.SUCCESS);
  });
