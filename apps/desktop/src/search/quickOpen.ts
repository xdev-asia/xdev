// Quick open ranking. Contract stub: Lane U (U1) fills it in.

import type { Range } from "@/palette/match";

/** How many files quick open keeps per worktree in its recent list. */
export const QUICK_OPEN_RECENT_MAX = 50;

/**
 * `files` ordered for `query`: the file name first, then the full path, scored with the palette's
 * `matchField`; `hits` are char ranges in `rel`. An empty query lists `recent` (newest first) and
 * then the rest in path order; a recent file gets a bonus only when it matches.
 */
export function rankFiles(files: string[], query: string, recent: string[]): { rel: string; hits: Range[] }[] {
  void query;
  void recent;
  return files.map((rel) => ({ rel, hits: [] }));
}
