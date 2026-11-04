import type { SidebarSort } from "@/api";

export type { SidebarSort };

/**
 * Rows in the order a sort asks for. `manual` keeps the input order; `recent` puts the latest output
 * first (`activity` holds the last output time by path), rows with none keep their input order at the end.
 * The sort is stable and returns a new array.
 */
export function sortEntries<T extends { path: string }>(
  entries: readonly T[],
  sort: SidebarSort,
  activity: Readonly<Record<string, number | null | undefined>> | undefined,
): T[] {
  if (sort !== "recent") return [...entries];
  const time = (e: T): number | null => activity?.[e.path] ?? null;
  return entries
    .map((entry, index) => ({ entry, index, at: time(entry) }))
    .sort((a, b) => {
      if (a.at === null || b.at === null) return a.at === b.at ? a.index - b.index : a.at === null ? 1 : -1;
      return b.at - a.at || a.index - b.index;
    })
    .map((x) => x.entry);
}

type Activity = Readonly<Record<string, number | null | undefined>>;

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
  input: { sort: SidebarSort; paths: readonly string[]; activity: Activity | undefined; focus: number },
): RecentSnapshot {
  const key = `${input.sort}|${input.focus}|${[...input.paths].sort().join("\n")}`;
  if (prev && prev.key === key) return prev;
  return { key, activity: input.sort === "recent" ? { ...input.activity } : {} };
}
