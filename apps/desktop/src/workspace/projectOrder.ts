import type { SidebarItem } from "@/api";

type Activity = Readonly<Record<string, number | null | undefined>>;

/** The newest output time among a repo's worktrees; null when none has any. */
function newest(repo: { worktrees: readonly { path: string }[] }, activity: Activity | undefined): number | null {
  let at: number | null = null;
  for (const wt of repo.worktrees) {
    const t = activity?.[wt.path] ?? null;
    if (t !== null && (at === null || t > at)) at = t;
  }
  return at;
}

/**
 * Repos with the most recently active one first. Repos with no activity keep their manual order at the
 * end. The sort is stable and returns a new array.
 */
export function orderRepos<T extends { worktrees: readonly { path: string }[] }>(repos: readonly T[], activity: Activity | undefined): T[] {
  return repos
    .map((repo, index) => ({ repo, index, at: newest(repo, activity) }))
    .sort((a, b) => {
      if (a.at === null || b.at === null) return a.at === b.at ? a.index - b.index : a.at === null ? 1 : -1;
      return b.at - a.at || a.index - b.index;
    })
    .map((x) => x.repo);
}

/**
 * The project list with its repos in recent order. Repos fill the slots repos had, so folders and groups
 * stay where they are; the members of a group are ordered the same way.
 */
export function orderItems(items: readonly SidebarItem[], activity: Activity | undefined): SidebarItem[] {
  const repos = orderRepos(
    items.flatMap((i) => (i.kind === "repo" ? [i.repo] : [])),
    activity,
  );
  let next = 0;
  return items.map((i): SidebarItem => {
    if (i.kind === "repo") {
      const repo = repos[next++];
      return items.find((x): x is Extract<SidebarItem, { kind: "repo" }> => x.kind === "repo" && x.repo === repo)!;
    }
    return i.kind === "group" ? { ...i, items: orderItems(i.items, activity) } : i;
  });
}
