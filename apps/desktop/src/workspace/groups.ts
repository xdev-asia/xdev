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
