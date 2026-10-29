/**
 * Fuzzy matching for the TUI file list: subsequence scoring with bonuses for
 * consecutive runs, path-segment boundaries, and basename hits. Pure and
 * dependency-free so it runs under vitest on any runtime.
 */

const SEPARATORS = new Set(["/", "\\", ".", "-", "_", " "]);

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Score `query` against `path` (full path). Returns null when the query is
 * not a case-insensitive subsequence of the path.
 */
export function fuzzyScore(query: string, path: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const basenameStart = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1;

  let score = 0;
  let pi = 0;
  let consecutive = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;
    for (let i = pi; i < p.length; i++) {
      if (p[i] === ch) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;

    // Consecutive-character bonus (compounding).
    if (found === pi && qi > 0) {
      consecutive += 1;
      score += 4 + consecutive;
    } else {
      consecutive = 0;
      score += 1;
    }
    // Boundary bonus: match right after a separator or at the string start.
    if (found === 0 || SEPARATORS.has(p[found - 1]!)) score += 6;
    // Basename matches matter more than directory hits.
    if (found >= basenameStart) score += 3;

    pi = found + 1;
  }
  // Prefer shorter paths and prefix-ish matches slightly.
  score += Math.max(0, 8 - Math.floor(p.length / 16));
  return score;
}

/** Filter and rank items by a fuzzy query; ties keep input order. */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  pathOf: (item: T) => string,
): Scored<T>[] {
  const scored: Scored<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, pathOf(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
