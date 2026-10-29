import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
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

/** List one directory: folders first, then files; media files only unless allFiles. */
export async function listDirectory(dir: string, allFiles: boolean): Promise<DirEntry[]> {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: DirEntry[] = [];
  const files: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path, isDir: true, sizeBytes: 0, supported: false });
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (!allFiles && !isSupportedMediaPath(path)) continue;
      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(path)).size;
      } catch {
        // Unreadable size is cosmetic.
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
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && isSupportedMediaPath(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  await walk(root, 0);
  return files.sort();
}

export async function buildQueue(paths: string[]): Promise<QueueItem[]> {
  const items: QueueItem[] = [];
  for (const path of paths) {
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(path)).size;
    } catch {
      // Unreadable size is cosmetic; keep the item.
    }
    items.push({ path, sizeBytes, status: "pending" });
  }
  return items;
}

/** Merge new paths into the queue, skipping ones already staged. */
export function stageInto(items: QueueItem[], paths: string[]): { items: QueueItem[]; added: string[] } {
  const known = new Set(items.map((item) => item.path));
  const added = paths.filter((path) => !known.has(path));
  if (added.length === 0) return { items, added };
  return { items: [...items, ...added.map((path) => ({ path, sizeBytes: 0, status: "pending" as const }))], added };
}

/** Remove a staged path from the queue (keeps running items). */
export function unstagePath(items: QueueItem[], path: string): QueueItem[] {
  const item = items.find((candidate) => candidate.path === path);
  if (!item || item.status === "running") return items;
  return items.filter((candidate) => candidate.path !== path);
}

export function queuePaths(items: QueueItem[]): string[] {
  return items.filter((item) => item.status !== "running").map((item) => item.path);
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
