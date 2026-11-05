/** The ids picked in the list. Each function returns a new set; the old one is not changed. */
export type Selection = ReadonlySet<string>;

/** Adds `id`, or removes it when it is picked already. */
export function toggle(selection: Selection, id: string): Selection {
  const next = new Set(selection);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * The ids from `anchor` to `id` in list order, either way round. A missing anchor (none, or a row
 * that has left the list) picks `id` alone; a missing `id` picks nothing.
 */
export function range(ids: readonly string[], anchor: string | null, id: string): Selection {
  const to = ids.indexOf(id);
  if (to < 0) return new Set();
  const from = anchor === null ? -1 : ids.indexOf(anchor);
  if (from < 0) return new Set([id]);
  return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
}

export function clear(): Selection {
  return new Set();
}
