import type { PrState, RepoView, SidebarGroupBy, WorkStatus } from "@/api";
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

/** One drawn section of the sidebar. `key` is unique across modes (`pr:open`), so a fold never carries over. */
export interface Section<T> {
  key: string;
  mode: SidebarGroupBy;
  /** The part of the key after the mode: a group, a status, a pull request state, a repo id; "" for none. */
  id: string;
  /** The repo of a `project` section. */
  repo?: RepoView;
  items: T[];
}

const STATUSES: readonly WorkStatus[] = ["todo", "in-progress", "in-review", "completed"];
const PR_STATES: readonly PrState[] = ["open", "draft", "merged", "closed"];

export interface GroupContext {
  dotOf(path: string): TabStatus | null;
  /** The state of the pull request of a worktree, if it has one. */
  prOf(path: string): PrState | null;
}

/** Entries bucketed by a fixed list of ids, "none" last; empty sections left out. One pass. */
function byIds<T>(mode: SidebarGroupBy, entries: T[], order: readonly string[], idOf: (e: T) => string): Section<T>[] {
  const buckets = new Map<string, T[]>([...order, "none"].map((id) => [id, []]));
  for (const e of entries) buckets.get(idOf(e))!.push(e);
  return [...buckets].filter(([, items]) => items.length > 0).map(([id, items]) => ({ key: `${mode}:${id}`, mode, id, items }));
}

/**
 * The sections the sidebar draws for a mode, in order, empty ones left out. Input order is kept inside
 * a section. `none` is one unnamed section; `project` follows the order the repos first appear.
 */
export function groupBy<T extends { path: string; repo: RepoView; wt: { status: WorkStatus | null } }>(
  entries: T[],
  mode: SidebarGroupBy,
  ctx: GroupContext,
): Section<T>[] {
  switch (mode) {
    case "none":
      return entries.length > 0 ? [{ key: "none", mode, id: "", items: entries }] : [];
    case "status":
      return byIds(mode, entries, STATUSES, (e) => e.wt.status ?? "none");
    case "pr":
      return byIds(mode, entries, PR_STATES, (e) => ctx.prOf(e.path) ?? "none");
    case "project": {
      const buckets = new Map<string, Section<T>>();
      for (const e of entries) {
        let s = buckets.get(e.repo.id);
        if (!s) buckets.set(e.repo.id, (s = { key: `project:${e.repo.id}`, mode, id: e.repo.id, repo: e.repo, items: [] }));
        s.items.push(e);
      }
      return [...buckets.values()];
    }
    default:
      return groupWorktrees(entries, ctx.dotOf).map((s) => ({ key: `activity:${s.group}`, mode: "activity" as const, id: s.group, items: s.items }));
  }
}

/** Paths in the order the sidebar draws them: section order, then row order, collapsed sections (by key) left out. */
export function orderedWorktrees<T extends { path: string }>(
  sections: { key: string; items: T[] }[],
  collapsed: readonly string[] = [],
): string[] {
  return sections.filter((s) => !collapsed.includes(s.key)).flatMap((s) => s.items.map((item) => item.path));
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
