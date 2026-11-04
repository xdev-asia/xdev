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
