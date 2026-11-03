import type { TabStatus } from "./status";

/** The sidebar sections, most urgent first. */
export type Group = "needs-you" | "working" | "review" | "rest";

export const GROUPS: readonly Group[] = ["needs-you", "working", "review", "rest"];

// A question and a failure both need the person; a finished turn waits for review.
const OF_DOT: Record<TabStatus, Group> = {
  "needs-you": "needs-you",
  failed: "needs-you",
  working: "working",
  done: "review",
  idle: "rest",
  exited: "rest",
};

export function groupOf(dot: TabStatus | null): Group {
  return dot ? OF_DOT[dot] : "rest";
}

/** Items split by the group of their status, in group order and input order, empty groups left out. One pass. */
export function groupWorktrees<T extends { path: string }>(
  items: T[],
  dotOf: (path: string) => TabStatus | null,
): { group: Group; items: T[] }[] {
  const buckets = new Map<Group, T[]>(GROUPS.map((g) => [g, []]));
  for (const item of items) buckets.get(groupOf(dotOf(item.path)))!.push(item);
  return GROUPS.flatMap((group) => {
    const found = buckets.get(group)!;
    return found.length > 0 ? [{ group, items: found }] : [];
  });
}

/** Paths in the order the sidebar draws them: group order, then list order, collapsed groups left out. */
export function orderedWorktrees<T extends { path: string }>(
  sections: { group: Group; items: T[] }[],
  collapsed: readonly Group[] = [],
): string[] {
  return sections.filter((s) => !collapsed.includes(s.group)).flatMap((s) => s.items.map((item) => item.path));
}

/**
 * The worktree a key asks for, in sidebar order: the next or previous one (wrapping; the first when
 * `current` is not listed), or the Nth. Null when there is nothing to pick.
 */
export function worktreeTarget(
  order: readonly string[],
  current: string | null,
  to: { step: 1 | -1 } | { nth: number },
): string | null {
  if (order.length === 0) return null;
  if ("nth" in to) return order[to.nth - 1] ?? null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return order[0];
  return order[(at + to.step + order.length) % order.length];
}
