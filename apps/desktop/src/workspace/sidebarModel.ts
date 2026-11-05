import type { KeptView, RepoView, SidebarItem, SidebarPrefs, WorkItem, WorktreeView } from "@/api";
import { isWorktreeVisible } from "./worktreeVisibility";

/** A worktree with the repo it belongs to; `path` keys the grouping. */
export interface WtEntry {
  path: string;
  wt: WorktreeView;
  repo: RepoView;
}

/** A worktree row: depth 1 is top-level, 2 sits under its parent. */
export interface NestRow {
  entry: WtEntry;
  depth: 1 | 2;
  /** How many listed worktrees name this one as their parent. */
  children: number;
}

/** The id an item has in the sidebar order. */
export function itemId(item: SidebarItem): string {
  return item.kind === "repo" ? item.repo.id : item.kind === "folder" ? item.folder.id : item.group.id;
}

/** Every repo, groups opened up, in the order the sidebar shows them. */
export function flattenRepos(items: SidebarItem[]): RepoView[] {
  return items.flatMap((i) => (i.kind === "repo" ? [i.repo] : i.kind === "group" ? flattenRepos(i.items) : []));
}

/**
 * The pinned worktrees, repo by repo in the order the sidebar shows the repos (groups opened up), and
 * within a repo in the order it lists them; the app keeps no time of the pin.
 */
export function pinnedEntries(items: SidebarItem[]): WtEntry[] {
  return flattenRepos(items).flatMap((repo) => repo.worktrees.filter((wt) => wt.pinned).map((wt): WtEntry => ({ path: wt.path, wt, repo })));
}

/** The kept branches of every repo, by repo id. */
export function keptByRepo(items: SidebarItem[]): Record<string, KeptView[]> {
  const out: Record<string, KeptView[]> = {};
  const walk = (list: SidebarItem[]) => {
    for (const i of list) {
      if (i.kind === "repo") out[i.repo.id] = i.kept;
      else if (i.kind === "group") walk(i.items);
    }
  };
  walk(items);
  return out;
}

/** The ids at the top level, in shown order (what `sidebar_order` takes). */
export function topIds(items: SidebarItem[]): string[] {
  return items.map(itemId);
}

/**
 * Where Alt+Arrow sends an item: a new top-level order, or a new index inside its group. Null at an end.
 */
export function moveTarget(items: SidebarItem[], id: string, delta: -1 | 1): { order: string[] } | { member: string; group: string; index: number } | null {
  const top = topIds(items);
  const at = top.indexOf(id);
  if (at >= 0) {
    const to = at + delta;
    if (to < 0 || to >= top.length) return null;
    const order = [...top];
    [order[at], order[to]] = [order[to], order[at]];
    return { order };
  }
  for (const i of items) {
    if (i.kind !== "group") continue;
    const index = i.items.map(itemId).indexOf(id);
    if (index < 0) continue;
    const to = index + delta;
    if (to < 0 || to >= i.items.length) return null;
    return { member: id, group: i.group.id, index: to };
  }
  return null;
}

const hidesBy = (wt: WorktreeView, prefs: SidebarPrefs): boolean =>
  (prefs.hideDefault && wt.defaultBranch) ||
  (prefs.hideDetached && wt.detached) ||
  (prefs.hideAutomation && wt.madeBy === "automation") ||
  (prefs.hideCli && wt.madeBy === "cli");

/** The Sleeping only filter: on, and the worktrees whose tabs are all asleep (path → asleep). */
export interface SleepingFilter {
  only: boolean;
  asleep: Readonly<Record<string, boolean | undefined>>;
}

/**
 * The repo ids a project filter keeps, or null when it keeps every project: the filter is empty, or
 * names no repo in `known` (an id of a repo that is gone is ignored, so it never empties the list).
 */
export function activeProjects(filter: readonly string[], known: Iterable<string>): Set<string> | null {
  const have = new Set(known);
  const kept = new Set(filter.filter((id) => have.has(id)));
  return kept.size === 0 ? null : kept;
}

/** The entries of the projects in the filter; all of them when it is empty or names no listed repo. */
export function filterByProject<T extends { repo: { id: string } }>(entries: T[], filter: readonly string[], known?: Iterable<string>): T[] {
  const kept = activeProjects(filter, known ?? entries.map((e) => e.repo.id));
  return kept ? entries.filter((e) => kept.has(e.repo.id)) : entries;
}

/**
 * The entries the filters leave, and how many they hid. The selected worktree is never hidden.
 * `sleeping` (not a stored preference) keeps only the worktrees that are asleep. A worktree the person
 * hid from the sidebar is left out and not counted: the hidden count is for the filters.
 */
export function visibleEntries(
  entries: WtEntry[],
  prefs: SidebarPrefs,
  selected: string | null,
  sleeping?: SleepingFilter,
  repoIds?: Iterable<string>,
): { entries: WtEntry[]; hidden: number } {
  const listed = entries.filter((e) => e.path === selected || isWorktreeVisible(e.wt, false, prefs));
  const projects = activeProjects(prefs.projectFilter, repoIds ?? entries.map((e) => e.repo.id));
  const shown = listed.filter(
    (e) => e.path === selected || ((!projects || projects.has(e.repo.id)) && !hidesBy(e.wt, prefs) && (!sleeping?.only || sleeping.asleep[e.path] === true)),
  );
  return { entries: shown, hidden: listed.length - shown.length };
}

/**
 * Puts each child right after its parent when both are in `entries`; a child whose parent is not
 * listed (gone, filtered out, or in another status section) stays top-level. `collapsed` holds the
 * parent paths whose children are folded away.
 */
export function nestRows(entries: WtEntry[], collapsed: ReadonlySet<string>): NestRow[] {
  const paths = new Set(entries.map((e) => e.path));
  const kids = new Map<string, WtEntry[]>();
  const top: WtEntry[] = [];
  for (const e of entries) {
    const parent = e.wt.parent;
    // One level only: a child never holds children of its own in the list.
    if (parent && parent !== e.path && paths.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), e]);
    else top.push(e);
  }
  return top.flatMap((e) => {
    const mine = kids.get(e.path) ?? [];
    const self: NestRow = { entry: e, depth: 1, children: mine.length };
    return collapsed.has(e.path) ? [self] : [self, ...mine.map((c): NestRow => ({ entry: c, depth: 2, children: 0 }))];
  });
}

/** The label of a work item chip: `#<number>` from the URL, else the title, else the host. */
export function itemLabel(item: WorkItem): string {
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return item.title || item.url;
  }
  const number = /\/(\d+)\/?$/.exec(url.pathname);
  if (number) return `#${number[1]}`;
  return item.title || url.host;
}

export type Move = { order: string[] } | { member: string; group: string | null; index: number };

/**
 * What dropping `dragged` on `target` does. A group heading takes a repo or folder in at the front;
 * a group moves only among the top-level items; a repo or folder lands before the row it is dropped on.
 */
export function dropMove(items: SidebarItem[], dragged: string, target: string): Move | null {
  if (dragged === target) return null;
  const top = topIds(items);
  const groupOf = (id: string) => items.find((i): i is Extract<SidebarItem, { kind: "group" }> => i.kind === "group" && i.items.some((m) => itemId(m) === id));
  const isGroup = (id: string) => items.some((i) => i.kind === "group" && i.group.id === id);
  const before = (list: string[]) => {
    const rest = list.filter((i) => i !== dragged);
    const at = rest.indexOf(target);
    return { rest, at };
  };
  if (isGroup(dragged)) {
    if (!top.includes(target)) return null;
    const { rest, at } = before(top);
    rest.splice(at, 0, dragged);
    return { order: rest };
  }
  if (isGroup(target)) return { member: dragged, group: target, index: 0 };
  const into = groupOf(target);
  if (into) return { member: dragged, group: into.group.id, index: before(into.items.map(itemId)).at };
  if (!top.includes(target)) return null;
  if (top.includes(dragged)) {
    const { rest, at } = before(top);
    rest.splice(at, 0, dragged);
    return { order: rest };
  }
  return { member: dragged, group: null, index: before(top).at };
}
