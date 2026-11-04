// What the search panel shows, as plain functions: the events of one search folded into a result.

import type { FileHits, SearchEvent, SearchQuery } from "@/api";
import type { Range } from "@/palette/match";

export interface SearchResult {
  phase: "idle" | "searching" | "done" | "error";
  files: FileHits[];
  hits: number;
  truncated: boolean;
  message: string | null;
}

export const IDLE: SearchResult = { phase: "idle", files: [], hits: 0, truncated: false, message: null };
export const STARTED: SearchResult = { ...IDLE, phase: "searching" };

export const countHits = (files: FileHits[]): number => files.reduce((n, f) => n + f.hits.length, 0);

/** The result after one more event of the search that is on screen. */
export function applyEvent(r: SearchResult, e: SearchEvent): SearchResult {
  switch (e.type) {
    case "batch": {
      const files = [...r.files, ...e.files];
      return { ...r, files, hits: countHits(files) };
    }
    case "done":
      return { ...r, phase: "done", hits: e.hits, truncated: e.truncated };
    case "error":
      return { ...r, phase: "error", message: e.message };
  }
}

/** `a, b` becomes `["a", "b"]`; a comma inside braces stays (`*.{ts,tsx}`). */
export function splitGlobs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((g) => g.trim()).filter(Boolean);
}

export interface SearchForm {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
}

export function toQuery(f: SearchForm): SearchQuery {
  return { text: f.text, caseSensitive: f.caseSensitive, wholeWord: f.wholeWord, regex: f.regex, include: splitGlobs(f.include), exclude: splitGlobs(f.exclude) };
}

/** `ranges` count code points (Rust chars); string slicing counts UTF-16 units. Converts the first to the second. */
export function unitRanges(text: string, ranges: [number, number][]): Range[] {
  const starts: number[] = [];
  let at = 0;
  for (const ch of text) {
    starts.push(at);
    at += ch.length;
  }
  starts.push(at);
  const unit = (i: number) => starts[Math.min(i, starts.length - 1)];
  return ranges.map(([s, e]): Range => [unit(s), unit(e)]);
}

/** The kept text is clipped to this many chars (`LINE_CLIP` in Rust); a shorter line is whole. */
export const LINE_CLIP = 400;

/** The 1-based column of the first range, or undefined when the line was clipped and the offset is not the line's. */
export function hitColumn(text: string, ranges: [number, number][]): number | undefined {
  if (ranges.length === 0 || Array.from(text).length >= LINE_CLIP) return undefined;
  return ranges[0][0] + 1;
}
