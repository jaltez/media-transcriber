import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { SUPPORTED_EXTENSIONS } from "../../types/index.js";

/**
 * The TUI file browser + staged queue. The Files pane lists the current
 * directory (folders first, media files by default); staged items persist as
 * you navigate and are what runs execute.
 */

export type QueueItemStatus = "pending" | "running" | "done" | "failed";

export interface QueueItem {
  path: string;
  sizeBytes: number;
  status: QueueItemStatus;
  /** Output artifact path after a successful run (txt/srt or enhanced wav) */
  output?: string;
  /** Enhancement report path, when the run produced one */
  reportPath?: string;
  error?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  supported: boolean;
}

export function isSupportedMediaPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.slice(dot).toLowerCase());
}

/** Above this many entries the size column is dropped to keep listing instant. */
export const MAX_STATED_ENTRIES = 500;

/**
 * List one directory: folders first, then files; media files only unless
 * allFiles. Returns null when the directory is missing or unreadable (the
 * caller distinguishes that from a genuinely empty folder).
 */
export async function listDirectory(dir: string, allFiles: boolean): Promise<DirEntry[] | null> {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  // One stat per media file is slow on huge folders; sizes are cosmetic.
  const withSizes = entries.length <= MAX_STATED_ENTRIES;
  const dirs: DirEntry[] = [];
  const files: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    // Symlinks take their target's kind (media libraries often sit behind links).
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue; // broken link
      }
    }
    if (isDir) {
      dirs.push({ name: entry.name, path, isDir: true, sizeBytes: 0, supported: false });
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (!allFiles && !isSupportedMediaPath(path)) continue;
      let sizeBytes = 0;
      if (withSizes) {
        try {
          sizeBytes = (await stat(path)).size;
        } catch {
          // Unreadable size is cosmetic.
        }
      }
      files.push({
        name: entry.name,
        path,
        isDir: false,
        sizeBytes,
        supported: isSupportedMediaPath(path),
      });
    }
  }

  const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name);
  return [...dirs.sort(byName), ...files.sort(byName)];
}

/** Recursively scan supported media files under root (bounded depth, sorted). */
export async function scanMediaFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      // Symlinks take their target's kind so linked media trees are reachable.
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(fullPath).isDirectory();
        } catch {
          continue; // broken link
        }
      }
      if (isDir) {
        await walk(fullPath, depth + 1);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && isSupportedMediaPath(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  await walk(root, 0);
  return files.sort();
}

/** Merge new paths into the queue, skipping ones already staged. sizeOf feeds
 * the size column (0 when unknown is fine — it is cosmetic). */
export function stageInto(
  items: QueueItem[],
  paths: string[],
  sizeOf: (path: string) => number = () => 0,
): { items: QueueItem[]; added: string[] } {
  const known = new Set(items.map((item) => item.path));
  const added = paths.filter((path) => !known.has(path));
  if (added.length === 0) return { items, added };
  return {
    items: [...items, ...added.map((path) => ({ path, sizeBytes: sizeOf(path), status: "pending" as const }))],
    added,
  };
}

/** Remove a staged path from the queue (keeps running items). */
export function unstagePath(items: QueueItem[], path: string): QueueItem[] {
  const item = items.find((candidate) => candidate.path === path);
  if (!item || item.status === "running") return items;
  return items.filter((candidate) => candidate.path !== path);
}

/** What a plain `r` runs: never-succeeded items, in queue order. */
export function pendingTargets(items: QueueItem[]): QueueItem[] {
  return items.filter((item) => item.status === "pending" || item.status === "failed");
}

/** Re-arm the queue for `R`: finished and failed items go back to pending. */
export function resetForRerun(items: QueueItem[]): QueueItem[] {
  return items.map((item) =>
    item.status === "running" ? item : { ...item, status: "pending" as const, error: undefined },
  );
}

/** Fit a path in maxWidth cells, keeping the tail (dir context over prefix). */
export function displayPath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path.padEnd(maxWidth);
  return `…${path.slice(-(maxWidth - 1))}`;
}

export function displayName(path: string, maxWidth: number): string {
  const name = basename(path);
  if (name.length <= maxWidth) return name;
  return `${name.slice(0, Math.max(1, maxWidth - 1))}…`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]!}`;
}
