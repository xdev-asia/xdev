import type { SidebarSort } from "@/api";

export type { SidebarSort };

/** What the name, smart and project sorts read from a row; a row without them sorts by its path. */
export interface Sortable {
  path: string;
  wt?: { name: string; title?: string | null };
  repo?: { shortName: string };
}

type Activity = Readonly<Record<string, number | null | undefined>>;

/** Class of an agent status for the smart sort: needs you or failed first, then done, then working, then the rest. */
function statusClass(status: string | null | undefined): number {
  if (status === "needs-you" || status === "failed") return 0;
  if (status === "done") return 1;
  if (status === "working") return 2;
  return 3;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byText = (a: string, b: string): number => collator.compare(a, b);
const labelOf = (e: Sortable): string => e.wt?.title || e.wt?.name || e.path;

/**
 * Rows in the order a sort asks for. `manual` keeps the input order. `recent` puts the latest output
 * first (`activity` holds the last output time by path), rows with none keep their input order at the end.
 * `name` sorts by title else name, ignoring case and accents, digits as numbers (wt-2 before wt-10), ties by
 * path. `smart` puts agents that need you first, then done, working and the rest, newest activity inside a
 * class, then name. `project` sorts by repo name, then name. The sort is stable and returns a new array.
 */
export function sortEntries<T extends Sortable>(
  entries: readonly T[],
  sort: SidebarSort,
  activity: Activity | undefined,
  /** The agent status by path, for `smart`. */
  statusOf?: (path: string) => string | null | undefined,
): T[] {
  if (sort === "manual") return [...entries];
  const time = (e: T): number | null => activity?.[e.path] ?? null;
  const byName = (a: T, b: T): number => byText(labelOf(a), labelOf(b)) || byText(a.path, b.path);
  const keyed = entries.map((entry, index) => ({ entry, index }));
  const order = (cmp: (a: T, b: T) => number) => keyed.sort((a, b) => cmp(a.entry, b.entry) || a.index - b.index).map((x) => x.entry);
  switch (sort) {
    case "name":
      return order(byName);
    case "project":
      return order((a, b) => byText(a.repo?.shortName ?? "", b.repo?.shortName ?? "") || byName(a, b));
    case "smart":
      return order((a, b) => {
        const c = statusClass(statusOf?.(a.path)) - statusClass(statusOf?.(b.path));
        if (c) return c;
        const [x, y] = [time(a), time(b)];
        if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
        return byName(a, b);
      });
    default:
      return order((a, b) => {
        const [x, y] = [time(a), time(b)];
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        return y - x;
      });
  }
}

/** The activity times a `recent` order was taken from, and what they were taken for. */
export interface RecentSnapshot {
  key: string;
  activity: Activity;
}

/**
 * The recent order is a snapshot: rows do not move under the cursor as output arrives. A new snapshot
 * is taken only when the sort changes, a worktree is added or removed, or `focus` (the count of window
 * focus events) moves. Otherwise `prev` comes back unchanged.
 */
export function recentSnapshot(
  prev: RecentSnapshot | null,
  input: { sort: SidebarSort; projectOrder?: string; paths: readonly string[]; activity: Activity | undefined; focus: number },
): RecentSnapshot {
  const key = `${input.sort}|${input.projectOrder ?? ""}|${input.focus}|${[...input.paths].sort().join("\n")}`;
  if (prev && prev.key === key) return prev;
  return { key, activity: input.sort === "recent" || input.sort === "smart" || input.projectOrder === "recent" ? { ...input.activity } : {} };
}
