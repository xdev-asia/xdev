/** `@<tab title>` in a hand-off message: where one is being typed, and which live tab the message goes to. */

export interface MentionTab {
  id: string;
  title: string;
}

export interface Mention {
  /** Where the `@` is. */
  start: number;
  /** What follows it up to the caret. */
  query: string;
}

/** The mention being typed at `caret`: an `@` at the start or after a space, then no line break. */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\r\n]/.test(query) || query.length > 80) return null;
  return { start: at, query };
}

/** Whether the query is a whole title already followed by a space: the mention is done, nothing to pick. */
export function mentionDone(tabs: readonly MentionTab[], query: string): boolean {
  if (!/\s$/.test(query)) return false;
  const q = query.trim().toLowerCase();
  return tabs.some((t) => t.title.toLowerCase() === q);
}

/** The tabs a query matches: titles that start with it first, then titles that contain it; any case. */
export function matchTabs<T extends MentionTab>(tabs: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...tabs];
  const starts = tabs.filter((t) => t.title.toLowerCase().startsWith(q));
  const has = tabs.filter((t) => !starts.includes(t) && t.title.toLowerCase().includes(q));
  return [...starts, ...has];
}

/** The text with the mention replaced by `@<title> `, and where the caret goes. */
export function applyMention(text: string, caret: number, m: Mention, title: string): { text: string; caret: number } {
  const head = `${text.slice(0, m.start)}@${title} `;
  const tail = text.slice(caret).replace(/^ /, "");
  return { text: head + tail, caret: head.length };
}

/**
 * The tab a message is handed to, from a leading `@<title>`, and the message without it. The longest matching title
 * wins, so "@Lead agent" picks "Lead agent" over "Lead". Null when the text does not start with a live tab's title.
 */
export function resolveMention<T extends MentionTab>(text: string, tabs: readonly T[]): { tab: T; body: string } | null {
  const s = text.trimStart();
  if (!s.startsWith("@")) return null;
  const rest = s.slice(1);
  const lower = rest.toLowerCase();
  const hits = tabs
    .filter((t) => t.title !== "" && lower.startsWith(t.title.toLowerCase()))
    .filter((t) => rest.length === t.title.length || /\s/.test(rest[t.title.length]))
    .sort((a, b) => b.title.length - a.title.length);
  const tab = hits[0];
  if (!tab) return null;
  return { tab, body: rest.slice(tab.title.length).trim() };
}
