import { cycleTab } from "./tabNav";

/** A Ctrl+Tab walk: the MRU list it started with (newest first), where the highlight is, and how many keys moved it. */
export interface Switch {
  list: string[];
  at: number;
  steps: number;
}

/**
 * The walk a first Ctrl+Tab (`1`) or Ctrl+Shift+Tab (`-1`) opens on `list`, with the highlight one step from
 * `current`. Null when there is no other tab to go to.
 */
export function startSwitch(list: readonly string[], current: string | null, step: 1 | -1): Switch | null {
  if (list.length < 2) return null;
  const to = cycleTab(list, current, step);
  if (to === null) return null;
  return { list: [...list], at: list.indexOf(to), steps: 1 };
}

/** The highlight one tab on (`1`) or back (`-1`), wrapping at both ends. */
export function stepSwitch(walk: Switch, step: 1 | -1): Switch {
  const n = walk.list.length;
  return { ...walk, at: (walk.at + step + n) % n, steps: walk.steps + 1 };
}

/** The tab the walk activates when Ctrl is let go. */
export function chosenTab(walk: Switch): string {
  return walk.list[walk.at];
}
