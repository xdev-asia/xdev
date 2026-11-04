import { matchItem, tokens, type Hits } from "./match";
import { validWorktreeName, type PaletteItem } from "./items";

export type Filter = "all" | "tab" | "worktree" | "task" | "other";
export const FILTERS: Filter[] = ["all", "tab", "worktree", "task", "other"];

export type Row =
  | { type: "header"; label: "recentTabs" | "recentWorktrees" | "tabs" | "worktrees" | "tasks" | "other" }
  | { type: "item"; item: PaletteItem; hits: Hits; digit: number | null }
  | { type: "more"; section: Filter; count: number }
  | { type: "create"; name: string };

export interface RankInput {
  items: PaletteItem[];
  query: string;
  filter: Filter;
  current: { worktree: string | null; tab: string | null };
  recent: (id: string) => number | null;
  extra: Partial<Record<Filter, number>>;
  canCreate: boolean;
  now: number;
  /** A repo folder: tab, chat, worktree and task items of other repos are left out. */
  scope: string | null;
}

const RECENT_TABS = 6;
const RECENT_TOTAL = 10;
export const PAGE = 8;
export const MORE = 20;
const NONE: Hits = { title: [], detail: [] };
const HOUR = 3_600_000;

type Section = "tab" | "worktree" | "task" | "other";
const SECTIONS: Section[] = ["tab", "worktree", "task", "other"];
const sectionOf = (item: PaletteItem): Section =>
  item.kind === "tab" || item.kind === "chat" ? "tab" : item.kind === "worktree" ? "worktree" : item.kind === "task" ? "task" : "other";
const LABEL = { tab: "tabs", worktree: "worktrees", task: "tasks", other: "other" } as const;

function urgency(item: PaletteItem): number {
  switch (item.status) {
    case "needs-you":
      return 0;
    case "done":
      return 1;
    case "failed":
      return 2;
    default:
      return 3;
  }
}

function bucket(at: number | null, now: number): number {
  if (at === null) return 4;
  const age = now - at;
  if (age < HOUR) return 0;
  if (age < 24 * HOUR) return 1;
  if (age < 7 * 24 * HOUR) return 2;
  return 3;
}

// Negative when `a` is newer; a missing time is the oldest.
const newest = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity) || 0;

function withDigits(rows: Row[]): Row[] {
  let n = 0;
  return rows.map((r) => (r.type === "item" ? { ...r, digit: n < 9 ? ++n : null } : r));
}

const itemRow = (item: PaletteItem, hits: Hits = NONE): Row => ({ type: "item", item, hits, digit: null });

function recentRows(input: RankInput): Row[] {
  const { items, current, recent } = input;
  const tabs = items
    .filter((i) => i.kind === "tab")
    .filter((i) => i.id !== `tab:${current.tab}` || i.status === "needs-you")
    .sort((a, b) => urgency(a) - urgency(b) || newest(recent(a.id), recent(b.id)) || (a.order ?? 0) - (b.order ?? 0))
    .slice(0, RECENT_TABS);
  // Past chats follow the live tabs in the same section, newest first.
  const chats = items
    .filter((i) => i.kind === "chat")
    .sort((a, b) => newest(a.activity ?? null, b.activity ?? null) || a.title.localeCompare(b.title))
    .slice(0, Math.max(0, RECENT_TABS - tabs.length));
  const first = [...tabs, ...chats];
  const count = first.length > 0 ? Math.max(1, RECENT_TOTAL - first.length) : RECENT_TOTAL;
  const worktrees = items
    .filter((i) => i.kind === "worktree" && i.worktree !== current.worktree)
    .sort((a, b) => newest(recent(a.id), recent(b.id)) || newest(a.activity ?? null, b.activity ?? null) || a.title.localeCompare(b.title))
    .slice(0, count);
  const rows: Row[] = [];
  if (first.length) rows.push({ type: "header", label: "recentTabs" }, ...first.map((i) => itemRow(i)));
  if (worktrees.length) rows.push({ type: "header", label: "recentWorktrees" }, ...worktrees.map((i) => itemRow(i)));
  return rows;
}

function typedRows(input: RankInput, toks: string[]): Row[] {
  const rows: Row[] = [];
  for (const section of SECTIONS) {
    if (input.filter !== "all" && input.filter !== section) continue;
    const found: { item: PaletteItem; hits: Hits; score: number }[] = [];
    for (const item of input.items) {
      if (sectionOf(item) !== section) continue;
      const m = matchItem(item, toks);
      if (m) found.push({ item, hits: m.hits, score: m.score });
    }
    found.sort(
      (a, b) =>
        b.score - a.score ||
        // On an equal score live tabs come before chats, and chats sort newest first.
        Number(a.item.kind === "chat") - Number(b.item.kind === "chat") ||
        (a.item.kind === "chat" && b.item.kind === "chat" ? newest(a.item.activity ?? null, b.item.activity ?? null) : 0) ||
        bucket(input.recent(a.item.id), input.now) - bucket(input.recent(b.item.id), input.now) ||
        a.item.title.localeCompare(b.item.title),
    );
    if (!found.length) continue;
    const shown = PAGE + (input.extra[section] ?? 0);
    rows.push({ type: "header", label: LABEL[section] });
    rows.push(...found.slice(0, shown).map((x) => itemRow(x.item, x.hits)));
    if (found.length > shown) rows.push({ type: "more", section, count: found.length - shown });
  }
  return rows;
}

/** The rows the palette shows for this query and filter, with digits on the first nine items. */
export function rank(all: RankInput): Row[] {
  const query = all.query.trim();
  const scoped = (i: PaletteItem) => all.scope === null || sectionOf(i) === "other" || i.repo === all.scope;
  // The Tasks filter lists tasks on an empty query; every other minQuery holds.
  const long = (i: PaletteItem) => query.length >= (i.minQuery ?? 0) || (query === "" && all.filter === "task" && i.kind === "task");
  const input = { ...all, items: all.items.filter((i) => long(i) && scoped(i)) };
  let rows: Row[];
  if (query === "") {
    if (input.filter === "all") rows = recentRows(input);
    else {
      const items = input.items.filter((i) => sectionOf(i) === input.filter);
      rows = items.length ? [{ type: "header", label: LABEL[input.filter as Section] }, ...items.map((i) => itemRow(i))] : [];
    }
  } else {
    rows = typedRows(input, tokens(query));
    if (input.canCreate && validWorktreeName(query)) rows.push({ type: "create", name: query });
  }
  return withDigits(rows);
}
