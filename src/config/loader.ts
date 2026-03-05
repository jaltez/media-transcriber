import { cosmiconfig } from "cosmiconfig";
import { configSchema, type Config, defaultConfig } from "./schema.js";

const MODULE_NAME = "media-transcriber";

/**
 * Load configuration from file, merging with defaults.
 * Searches for: .media-transcriber.json, .media-transcriber.yaml,
 * media-transcriber.config.js, or "media-transcriber" key in package.json.
 */
export async function loadConfig(
  configPath?: string,
): Promise<{ config: Config; filepath: string | null }> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.yaml`,
      `.${MODULE_NAME}rc.yml`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.mjs`,
      "config.json",
      "package.json",
    ],
  });

  let rawConfig: Record<string, unknown> = {};
  let filepath: string | null = null;

  if (configPath) {
    const result = await explorer.load(configPath);
    if (result) {
      rawConfig = result.config as Record<string, unknown>;
      filepath = result.filepath;
    }
  } else {
    const result = await explorer.search();
    if (result) {
      rawConfig = result.config as Record<string, unknown>;
      filepath = result.filepath;
    }
  }

  const merged = { ...defaultConfig, ...rawConfig };
  const config = configSchema.parse(merged);
  return { config, filepath };
}

/** Apply CLI argument overrides to config */
export function applyCliOverrides(
  config: Config,
  overrides: Partial<Config>,
): Config {
  const merged = { ...config };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return configSchema.parse(merged);
}
