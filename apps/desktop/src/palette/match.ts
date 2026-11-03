/** A run of matched characters, `end` exclusive. */
export type Range = [start: number, end: number];

export interface Hits {
  title: Range[];
  detail: Range[];
}

const MAX_TOKENS = 8;
const EXACT = 100;
const PREFIX = 80;
const WORD = 60;
const SUBSTRING = 40;
const SEQUENCE = 20;

const TITLE_WEIGHT = 1;
const DETAIL_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.5;

/** The words of a query: lowercased, without repeats, at most eight. */
export function tokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TOKENS);
}

const SEPARATORS = " -_/.·:";

// A word starts at the start, after a separator, or where lower case turns upper.
function wordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (SEPARATORS.includes(prev)) return true;
  return prev !== prev.toUpperCase() && cur !== cur.toLowerCase() && cur === cur.toUpperCase();
}

/** How well one query word matches one text, best tier first; null when it does not. */
export function matchField(token: string, text: string): { score: number; hits: Range[] } | null {
  const lower = text.toLowerCase();
  const n = token.length;
  if (n === 0) return null;
  if (lower === token) return { score: EXACT, hits: [[0, n]] };
  if (lower.startsWith(token)) return { score: PREFIX, hits: [[0, n]] };
  for (let i = lower.indexOf(token, 1); i > 0; i = lower.indexOf(token, i + 1)) {
    if (wordStart(text, i)) return { score: WORD, hits: [[i, i + n]] };
  }
  // One letter anywhere in a word would match nearly everything.
  if (n === 1) return null;
  const at = lower.indexOf(token);
  if (at >= 0) return { score: SUBSTRING, hits: [[at, at + n]] };
  return sequence(token, lower);
}

// The letters in order with gaps between them; fewer skipped letters score higher.
function sequence(token: string, lower: string): { score: number; hits: Range[] } | null {
  const hits: Range[] = [];
  let gaps = 0;
  let from = 0;
  for (const ch of token) {
    const at = lower.indexOf(ch, from);
    if (at < 0) return null;
    if (hits.length > 0) gaps += at - from;
    const last = hits.at(-1);
    if (last && last[1] === at) last[1] = at + 1;
    else hits.push([at, at + 1]);
    from = at + 1;
  }
  return { score: Math.max(1, SEQUENCE - gaps), hits };
}

/** Sorts and joins touching or overlapping ranges. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Every query word must match the title, the detail or a keyword; each takes its best
 * weighted match. Null when one word matches nowhere.
 */
export function matchItem(
  item: { title: string; detail?: string; keywords?: string[] },
  toks: string[],
): { score: number; hits: Hits } | null {
  const title: Range[] = [];
  const detail: Range[] = [];
  let score = 0;
  for (const tok of toks) {
    let best: { score: number; field: "title" | "detail" | "keyword"; hits: Range[] } | null = null;
    const consider = (text: string | undefined, weight: number, field: "title" | "detail" | "keyword") => {
      if (!text) return;
      const m = matchField(tok, text);
      if (m && (!best || m.score * weight > best.score)) best = { score: m.score * weight, field, hits: m.hits };
    };
    consider(item.title, TITLE_WEIGHT, "title");
    consider(item.detail, DETAIL_WEIGHT, "detail");
    for (const k of item.keywords ?? []) consider(k, KEYWORD_WEIGHT, "keyword");
    if (!best) return null;
    const found: { score: number; field: string; hits: Range[] } = best;
    score += found.score;
    if (found.field === "title") title.push(...found.hits);
    else if (found.field === "detail") detail.push(...found.hits);
  }
  return { score, hits: { title: mergeRanges(title), detail: mergeRanges(detail) } };
}
