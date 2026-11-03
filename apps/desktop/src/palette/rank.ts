import { matchItem, tokens, type Hits } from "./match";
import { validWorktreeName, type PaletteItem } from "./items";

export type Filter = "all" | "tab" | "worktree" | "other";
export const FILTERS: Filter[] = ["all", "tab", "worktree", "other"];

export type Row =
  | { type: "header"; label: "recentTabs" | "recentWorktrees" | "tabs" | "worktrees" | "other" }
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
}

const RECENT_TABS = 6;
const RECENT_TOTAL = 10;
export const PAGE = 8;
export const MORE = 20;
const NONE: Hits = { title: [], detail: [] };
const HOUR = 3_600_000;

type Section = "tab" | "worktree" | "other";
const sectionOf = (item: PaletteItem): Section => (item.kind === "tab" ? "tab" : item.kind === "worktree" ? "worktree" : "other");
const LABEL = { tab: "tabs", worktree: "worktrees", other: "other" } as const;

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
  const count = tabs.length > 0 ? Math.max(1, RECENT_TOTAL - tabs.length) : RECENT_TOTAL;
  const worktrees = items
    .filter((i) => i.kind === "worktree" && i.worktree !== current.worktree)
    .sort((a, b) => newest(recent(a.id), recent(b.id)) || newest(a.activity ?? null, b.activity ?? null) || a.title.localeCompare(b.title))
    .slice(0, count);
  const rows: Row[] = [];
  if (tabs.length) rows.push({ type: "header", label: "recentTabs" }, ...tabs.map((i) => itemRow(i)));
  if (worktrees.length) rows.push({ type: "header", label: "recentWorktrees" }, ...worktrees.map((i) => itemRow(i)));
  return rows;
}

function typedRows(input: RankInput, toks: string[]): Row[] {
  const rows: Row[] = [];
  for (const section of ["tab", "worktree", "other"] as const) {
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
export function rank(input: RankInput): Row[] {
  const query = input.query.trim();
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
