import { readdir, stat } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { existsSync } from "node:fs";
import { SUPPORTED_EXTENSIONS } from "../../types/index.js";

/**
 * The TUI file queue: a scanned root plus per-item run state. Pure model —
 * the app renders it, the runner mutates it.
 */

export type QueueItemStatus = "pending" | "running" | "done" | "failed";

export interface QueueItem {
  path: string;
  sizeBytes: number;
  selected: boolean;
  status: QueueItemStatus;
  /** Output artifact path after a successful run (txt/srt or enhanced wav) */
  output?: string;
  /** Enhancement report path, when the run produced one */
  reportPath?: string;
  error?: string;
}

/** Recursively scan supported media files under root (bounded, sorted). */
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
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if ((SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(root, 0);
  return files.sort();
}

export async function buildQueue(paths: string[], selectedByDefault = true): Promise<QueueItem[]> {
  const items: QueueItem[] = [];
  for (const path of paths) {
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(path)).size;
    } catch {
      // Unreadable size is cosmetic; keep the item.
    }
    items.push({ path, sizeBytes, selected: selectedByDefault, status: "pending" });
  }
  return items;
}

export function toggleAt(items: QueueItem[], index: number): QueueItem[] {
  const item = items[index];
  if (!item || item.status === "running") return items;
  const next = [...items];
  next[index] = { ...item, selected: !item.selected };
  return next;
}

export function selectAll(items: QueueItem[], selected: boolean): QueueItem[] {
  return items.map((item) =>
    item.status === "running" ? item : { ...item, selected },
  );
}

export function selectedPaths(items: QueueItem[]): string[] {
  return items.filter((item) => item.selected && item.status !== "running").map((item) => item.path);
}

export function displayName(path: string, maxWidth: number): string {
  const name = basename(path);
  if (name.length <= maxWidth) return name;
  return `${name.slice(0, Math.max(1, maxWidth - 1))}…`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]!}`;
}
