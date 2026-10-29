import { SUPPORTED_EXTENSIONS } from "../../types/index.js";

/**
 * Parse pasted/dropped terminal text into file paths.
 *
 * Terminals deliver dragged files as pasted text: usually newline-separated
 * absolute paths, sometimes quoted when they contain spaces, occasionally
 * space-separated on a single line. Pure module — the caller supplies the
 * filesystem probes so tests can be hermetic.
 */

export interface PasteProbes {
  exists(path: string): boolean;
  isFile(path: string): boolean;
}

export interface ParsedPaste {
  /** Existing files with supported media extensions */
  files: string[];
  /** Existing directories (candidate scan roots) */
  dirs: string[];
  /** Existing paths that are neither (wrong extension, etc.) or nonexistent tokens */
  rejected: string[];
}

function unquote(token: string): string {
  const trimmed = token.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isSupportedMediaFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.slice(dot).toLowerCase());
}

/**
 * Split pasted text into path tokens. Newlines always separate; a single line
 * containing several space-separated existing paths also splits.
 */
export function splitPathTokens(text: string, probes: PasteProbes): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/).map(unquote).filter(Boolean);
    if (parts.length <= 1) {
      tokens.push(unquote(line));
      continue;
    }
    // Space-separated: treat as multiple paths only when every part exists;
    // otherwise the line is a single (possibly spaced) path.
    if (parts.every((part) => probes.exists(part))) {
      tokens.push(...parts);
    } else {
      tokens.push(unquote(line));
    }
  }
  return [...new Set(tokens)];
}

export function parsePastedPaths(text: string, probes: PasteProbes): ParsedPaste {
  const files: string[] = [];
  const dirs: string[] = [];
  const rejected: string[] = [];

  for (const token of splitPathTokens(text, probes)) {
    if (!probes.exists(token)) {
      rejected.push(token);
      continue;
    }
    if (probes.isFile(token)) {
      if (isSupportedMediaFile(token)) {
        files.push(token);
      } else {
        rejected.push(token);
      }
    } else {
      dirs.push(token);
    }
  }

  return { files, dirs, rejected };
}
