import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Disk cache for expensive dependency probes. Discovering whisper or
 * DeepFilterNet spawns a Python process that imports torch, which costs
 * seconds per probe; without a cache every doctor/transcribe invocation
 * pays that cost again.
 *
 * Freshness policy: "available" results live longer (installations rarely
 * vanish) than "not found" results (a fresh install should be picked up
 * quickly). Launch failures in the backends invalidate the matching key so
 * a stale positive entry cannot break runs for the whole TTL.
 */

const CACHE_SCHEMA_VERSION = 1;

export const POSITIVE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const NEGATIVE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const PROBE_CACHE_KEYS = {
  ffmpeg: "ffmpeg-v1",
  whisper: "whisper-v1",
  deepfilternet: "deepfilternet-v1",
  parakeet: "parakeet-v1",
} as const;

let disabled = false;

/** Disable caching for the remainder of this process (doctor --no-cache). */
export function setProbeCacheDisabled(state = true): void {
  disabled = state;
}

export function isProbeCacheDisabled(): boolean {
  return disabled || process.env["MEDIA_TRANSCRIBER_NO_CACHE"] === "1";
}

interface ProbeCacheEntry<T> {
  schema: number;
  storedAt: number;
  value: T;
}

function cacheDirPath(): string | null {
  const override = process.env["MEDIA_TRANSCRIBER_CACHE_DIR"];
  if (override) return override;

  switch (process.platform) {
    case "win32": {
      const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      return join(localAppData, "media-transcriber", "cache");
    }
    case "darwin":
      return join(homedir(), "Library", "Caches", "media-transcriber");
    default: {
      const xdg = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
      return join(xdg, "media-transcriber");
    }
  }
}

function cacheFilePath(key: string): string | null {
  if (isProbeCacheDisabled()) return null;
  const dir = cacheDirPath();
  if (!dir) return null;
  return join(dir, `${key}.json`);
}

export async function readProbeCache<T>(
  key: string,
  isPositive: (value: T) => boolean,
): Promise<T | null> {
  const path = cacheFilePath(key);
  if (!path) return null;

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  try {
    const entry = JSON.parse(raw) as ProbeCacheEntry<T>;
    if (entry.schema !== CACHE_SCHEMA_VERSION || typeof entry.storedAt !== "number") {
      return null;
    }
    const ttl = isPositive(entry.value) ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - entry.storedAt > ttl) return null;
    return entry.value;
  } catch {
    // Corrupt or half-written entry: drop it and recompute.
    await unlink(path).catch(() => {});
    return null;
  }
}

export async function writeProbeCache<T>(key: string, value: T): Promise<void> {
  const path = cacheFilePath(key);
  if (!path) return;

  try {
    await mkdir(dirname(path), { recursive: true });
    const entry: ProbeCacheEntry<T> = {
      schema: CACHE_SCHEMA_VERSION,
      storedAt: Date.now(),
      value,
    };
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmpPath = `${path}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entry), "utf-8");
    await rename(tmpPath, path);
  } catch {
    // Caching is best effort; a failed write only costs speed.
  }
}

/**
 * Remove one cache key, or every cached probe when no key is given
 * (used after setup installs a tool).
 */
export async function invalidateProbeCache(...keys: string[]): Promise<void> {
  const dir = cacheDirPath();
  if (!dir) return;

  if (keys.length > 0) {
    await Promise.all(keys.map((key) => unlink(join(dir, `${key}.json`)).catch(() => {})));
    return;
  }

  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => unlink(join(dir, name)).catch(() => {})),
    );
  } catch {
    // Missing cache directory: nothing to invalidate.
  }
}

/**
 * Read-through cache wrapper for a probe. `isPositive` selects the TTL:
 * long for available tools, short for "not found" answers.
 */
export async function withProbeCache<T>(
  key: string,
  isPositive: (value: T) => boolean,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = await readProbeCache<T>(key, isPositive);
  if (cached !== null) return cached;

  const value = await compute();
  await writeProbeCache(key, value);
  return value;
}
