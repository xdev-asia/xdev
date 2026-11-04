/** The tab after (`1`) or before (`-1`) `current` in `ids`, wrapping; the first one when `current` is not there. */
export function cycleTab(ids: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return ids[0];
  return ids[(at + step + ids.length) % ids.length];
}

/** The Nth tab (1-based) of `ids`; 9 is the last one, as in a browser; null when there is no such tab. */
export function nthTab(ids: readonly string[], n: number): string | null {
  if (ids.length === 0) return null;
  if (n === 9) return ids[ids.length - 1];
  return ids[n - 1] ?? null;
}

/**
 * `ids` in the order Ctrl+Tab walks them most recent first: the ones in `recent` (newest first), then the rest
 * in strip order. A tab in `recent` that is no longer in `ids` is dropped.
 */
export function mruOrder(ids: readonly string[], recent: readonly string[]): string[] {
  const here = new Set(ids);
  const seen = new Set<string>();
  const first = recent.filter((id) => here.has(id) && !seen.has(id) && !!seen.add(id));
  return [...first, ...ids.filter((id) => !seen.has(id))];
}
