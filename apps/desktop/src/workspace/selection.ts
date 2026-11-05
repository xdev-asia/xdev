import { toApiError, type ApiError, type KeptBranch, type Removed } from "@/api";

/** The selected worktree paths, and the row a Shift-click ranges from. */
export interface Selection {
  paths: Set<string>;
  anchor: string | null;
}

export const clear = (): Selection => ({ paths: new Set(), anchor: null });

/**
 * A click with modifiers. Ctrl (Cmd) toggles one row; Shift selects the range from the anchor in
 * `order` (the visible, selectable rows); a plain click selects just that row. Paths not in `order`
 * (primary rows, hidden rows) are never added.
 */
export function click(sel: Selection, path: string, order: string[], mods: { toggle: boolean; range: boolean }): Selection {
  if (!order.includes(path)) return sel;
  if (mods.range && sel.anchor && order.includes(sel.anchor)) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(path);
    const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { paths: new Set(mods.toggle ? [...sel.paths, ...span] : span), anchor: sel.anchor };
  }
  if (mods.toggle) {
    const paths = new Set(sel.paths);
    if (!paths.delete(path)) paths.add(path);
    return { paths, anchor: path };
  }
  return { paths: new Set([path]), anchor: path };
}

/** Ctrl+A: every row in `order`. */
export const selectAll = (order: string[]): Selection => ({ paths: new Set(order), anchor: order[0] ?? null });

export interface BulkResult {
  ok: string[];
  failed: { path: string; error: ApiError }[];
  kept: KeptBranch[];
}

/**
 * Runs `op` over `paths` one after another. `before` (closing the worktree's terminals) finishes
 * before `op` starts for the same path. A failure is recorded and the next path still runs.
 */
export async function runBulk(paths: string[], op: (path: string) => Promise<Removed | void>, before: (path: string) => Promise<void>): Promise<BulkResult> {
  const out: BulkResult = { ok: [], failed: [], kept: [] };
  for (const path of paths) {
    try {
      await before(path);
      const done = await op(path);
      out.ok.push(path);
      if (done && done.kept) out.kept.push(done.kept);
    } catch (e) {
      out.failed.push({ path, error: toApiError(e) });
    }
  }
  return out;
}

/** True when at least one of `paths` has an awake tab to put to sleep (a path not in `map` counts as not sleepable). */
export const bulkSleepable = (paths: Iterable<string>, map: Record<string, boolean>): boolean => [...paths].some((p) => map[p] === true);
