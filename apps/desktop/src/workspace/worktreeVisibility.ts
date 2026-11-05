import type { RepoView, SidebarPrefs, WorktreeView } from "@/api";

/**
 * A path as compared: `\` read as `/`, no trailing separator, and a Windows drive letter in lower case
 * (`C:\code\x` and `c:/code/x` are one folder). The rest of the path keeps its case.
 */
export function visibilityKey(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/");
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  return trimmed.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

/** The paths with blanks dropped and each folder named once, in the spelling met first. */
export function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = visibilityKey(path);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(path.trim());
  }
  return out;
}

export function hasPath(paths: readonly string[], path: string): boolean {
  const key = visibilityKey(path);
  return paths.some((p) => visibilityKey(p) === key);
}

const without = (paths: readonly string[], path: string): string[] => {
  const key = visibilityKey(path);
  return paths.filter((p) => visibilityKey(p) !== key);
};

/**
 * Whether the sidebar lists a worktree. The primary checkout always shows. A path in `hiddenWorktrees`
 * never shows. A worktree made outside xDev (`external`) shows unless `externalDefaultHidden` is on and
 * the path is not in `shownWorktrees`.
 */
export function isWorktreeVisible(wt: Pick<WorktreeView, "path" | "primary">, external: boolean, prefs: SidebarPrefs): boolean {
  if (wt.primary) return true;
  if (hasPath(prefs.hiddenWorktrees, wt.path)) return false;
  if (external && prefs.externalDefaultHidden) return hasPath(prefs.shownWorktrees, wt.path);
  return true;
}

/** Shows or hides one worktree; the lists stay free of repeats and a path is in at most one of them. */
export function setWorktreeShown(prefs: SidebarPrefs, path: string, external: boolean, shown: boolean): SidebarPrefs {
  if (shown) {
    return {
      ...prefs,
      hiddenWorktrees: without(prefs.hiddenWorktrees, path),
      shownWorktrees: external && prefs.externalDefaultHidden ? dedupePaths([...prefs.shownWorktrees, path]) : without(prefs.shownWorktrees, path),
    };
  }
  return { ...prefs, hiddenWorktrees: dedupePaths([...prefs.hiddenWorktrees, path]), shownWorktrees: without(prefs.shownWorktrees, path) };
}

/** "Restore all": nothing is hidden, and every listed outside worktree shows. */
export function restoreAll(prefs: SidebarPrefs, external: readonly string[]): SidebarPrefs {
  return { ...prefs, hiddenWorktrees: [], shownWorktrees: prefs.externalDefaultHidden ? dedupePaths([...prefs.shownWorktrees, ...external]) : [] };
}

/**
 * The outside worktrees the person has not decided on yet: with `externalDefaultHidden` on, those in
 * neither list. Empty when it is off, because they show.
 */
export function newExternal(external: readonly string[], prefs: SidebarPrefs): string[] {
  if (!prefs.externalDefaultHidden) return [];
  return dedupePaths(external).filter((p) => !hasPath(prefs.hiddenWorktrees, p) && !hasPath(prefs.shownWorktrees, p));
}

/** Marks `paths` as seen: they stay hidden, and the review line stops counting them. */
export function acknowledgeNew(prefs: SidebarPrefs, paths: readonly string[]): SidebarPrefs {
  return { ...prefs, hiddenWorktrees: dedupePaths([...prefs.hiddenWorktrees, ...paths]) };
}

/** One row of the visibility dialog. */
export interface VisibilityRow {
  path: string;
  name: string;
  branch: string | null;
  repoId: string;
  repoName: string;
  /** Made outside xDev (not yet adopted). */
  external: boolean;
  visible: boolean;
}

/** The worktrees made outside xDev, then the managed ones the person hid; each with whether it shows. */
export function visibilityRows(repos: readonly RepoView[], prefs: SidebarPrefs): VisibilityRow[] {
  const rows: VisibilityRow[] = [];
  const row = (repo: RepoView, wt: WorktreeView, external: boolean): VisibilityRow => ({
    path: wt.path,
    name: wt.title ?? wt.name,
    branch: wt.branch,
    repoId: repo.id,
    repoName: repo.shortName,
    external,
    visible: isWorktreeVisible(wt, external, prefs),
  });
  for (const repo of repos) for (const wt of repo.found) rows.push(row(repo, wt, true));
  for (const repo of repos) for (const wt of repo.worktrees) if (!wt.primary && hasPath(prefs.hiddenWorktrees, wt.path)) rows.push(row(repo, wt, false));
  return rows;
}
