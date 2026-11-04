// Quick open ranking: the file name first, then the full path, scored with the palette's matcher.

import { matchField, mergeRanges, tokens, type Range } from "@/palette/match";

/** How many files quick open keeps per worktree in its recent list. */
export const QUICK_OPEN_RECENT_MAX = 50;

/** How many rows `rankFiles` returns at most. */
export const QUICK_OPEN_LIMIT = 200;

// A path match counts less than a file name match of the same tier.
const PATH_WEIGHT = 0.6;
const RECENT_BONUS = 25;

export interface Ranked {
  rel: string;
  hits: Range[];
}

/** `App.tsx:42` is the path `App.tsx` and the line 42. */
export function splitLine(input: string): { query: string; line?: number } {
  const m = /^(.*?):(\d+)$/.exec(input.trim());
  if (!m || Number(m[2]) < 1) return { query: input };
  return { query: m[1], line: Number(m[2]) };
}

// One token against one file: the best of its name and its path, with ranges in `rel`.
function matchToken(token: string, rel: string): { score: number; hits: Range[] } | null {
  const cut = rel.lastIndexOf("/") + 1;
  const name = matchField(token, rel.slice(cut));
  const path = matchField(token, rel);
  const byName = name ? { score: name.score, hits: name.hits.map(([s, e]): Range => [s + cut, e + cut]) } : null;
  const byPath = path ? { score: path.score * PATH_WEIGHT, hits: path.hits } : null;
  if (byName && (!byPath || byName.score >= byPath.score)) return byName;
  return byPath;
}

/**
 * `files` ordered for `query`; `hits` are char ranges in `rel`. An empty query lists `recent`
 * (newest first, only the ones still in `files`) and then the rest in path order; a recent file
 * gets a bonus only when it matches.
 */
export function rankFiles(files: string[], query: string, recent: string[], limit: number = QUICK_OPEN_LIMIT): Ranked[] {
  const words = tokens(query);
  if (words.length === 0) {
    const have = new Set(files);
    const first = recent.filter((r) => have.has(r));
    const seen = new Set(first);
    const rest = files.filter((f) => !seen.has(f));
    return [...first, ...rest].slice(0, limit).map((rel) => ({ rel, hits: [] }));
  }
  const rank = new Map(recent.map((r, i) => [r, i]));
  const scored: { rel: string; hits: Range[]; score: number }[] = [];
  for (const rel of files) {
    let score = 0;
    const hits: Range[] = [];
    let ok = true;
    for (const w of words) {
      const m = matchToken(w, rel);
      if (!m) {
        ok = false;
        break;
      }
      score += m.score;
      hits.push(...m.hits);
    }
    if (!ok) continue;
    const at = rank.get(rel);
    if (at !== undefined) score += Math.max(5, RECENT_BONUS - at);
    scored.push({ rel, hits: mergeRanges(hits), score });
  }
  scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1));
  return scored.slice(0, limit).map(({ rel, hits }) => ({ rel, hits }));
}
