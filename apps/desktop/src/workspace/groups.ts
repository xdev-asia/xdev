import type { TabStatus } from "./status";

/** The sidebar sections, most urgent first. */
export type Group = "needs-you" | "working" | "review" | "rest";

export const GROUPS: readonly Group[] = ["needs-you", "working", "review", "rest"];

// Until `needs-you` and `done` have their own sources, a failed agent is what needs the user and
// an idle one is waiting for review.
const OF_DOT: Record<TabStatus, Group> = {
  failed: "needs-you",
  working: "working",
  idle: "review",
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
