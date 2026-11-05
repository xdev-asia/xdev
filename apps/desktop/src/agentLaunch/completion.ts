/** Completion of the first prompt: `/` lists skills, `@` lists files of the worktree. */
export type Trigger = "/" | "@";
export type Token = { trigger: Trigger; query: string; start: number; end: number };

/** How many matches the list shows. */
export const MAX_SHOWN = 50;

/**
 * The completion token the cursor is in: a word that starts at the text start or after whitespace
 * with `/` or `@`. `query` is what follows the trigger up to the cursor; `end` is the end of the word.
 */
export function tokenAtCursor(text: string, cursor: number): Token | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const first = text[start];
  if (first !== "/" && first !== "@") return null;
  if (start === cursor) return null;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { trigger: first, query: text.slice(start + 1, cursor), start, end };
}

/** 0 best; null when `item` does not match `query`. Case-insensitive. */
function score(item: string, query: string): number | null {
  if (query === "") return 0;
  const hay = item.toLowerCase();
  const q = query.toLowerCase();
  const base = hay.slice(hay.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 0;
  if (hay.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (hay.includes(q)) return 3;
  let at = 0;
  for (const c of q) {
    at = hay.indexOf(c, at) + 1;
    if (at === 0) return null;
  }
  return 4;
}

/** The items matching `query`, best first (then shorter, then A to Z), at most `max`. */
export function rankMatches(items: readonly string[], query: string, max = MAX_SHOWN): string[] {
  const scored: { item: string; s: number }[] = [];
  for (const item of items) {
    const s = score(item, query);
    if (s !== null) scored.push({ item, s });
  }
  scored.sort((a, b) => a.s - b.s || a.item.length - b.item.length || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  return scored.slice(0, max).map((x) => x.item);
}

/** `text` with the token replaced by `/name ` or `@path `, and the cursor after it. */
export function insertCompletion(text: string, token: Token, value: string): { text: string; cursor: number } {
  const insert = `${token.trigger}${value} `;
  const after = text.slice(token.end).replace(/^ /, "");
  return { text: text.slice(0, token.start) + insert + after, cursor: token.start + insert.length };
}

export type CompletionKey = "ArrowUp" | "ArrowDown" | "Enter" | "Tab" | "Escape";
export type KeyResult = { index: number; action: "none" | "accept" | "close" };

/** The list's reaction to a key: the highlighted row (wrapping), and whether to insert it or close. */
export function completionKey(key: string, index: number, count: number): KeyResult | null {
  if (count === 0) return key === "Escape" ? { index, action: "close" } : null;
  switch (key) {
    case "ArrowDown":
      return { index: (index + 1) % count, action: "none" };
    case "ArrowUp":
      return { index: (index - 1 + count) % count, action: "none" };
    case "Enter":
    case "Tab":
      return { index, action: "accept" };
    case "Escape":
      return { index, action: "close" };
    default:
      return null;
  }
}
