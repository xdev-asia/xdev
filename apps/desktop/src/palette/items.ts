import { chordLabel } from "@/keys/keymap";
import type { RepoView, WorktreeView } from "@/api";
import { SECTIONS } from "@/settings/sections";
import type { Tab } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";

export type PaletteKind = "tab" | "worktree" | "setting" | "action";
/** What an agent wants from the person; supplied by the status feature when it exists. */
export type Attention = "needs-you" | "done";
export type ItemStatus = TabStatus | Attention;

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  title: string;
  detail?: string;
  keywords?: string[];
  /** A key hint shown on the right, such as `Ctrl K`. */
  hint?: string;
  status?: ItemStatus | null;
  /** Worktrees: last terminal activity in ms, or null. */
  activity?: number | null;
  /** Tabs and worktrees: the worktree path they belong to. */
  worktree?: string;
  /** Tabs: the position in open order, for stable ordering. */
  order?: number;
  run(): void;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

export function worktreeItems(
  repos: RepoView[],
  ctx: {
    dot(path: string): TabStatus | null;
    activity(path: string): number | null;
    detached: string;
    onPick(wt: WorktreeView): void;
  },
): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const repo of repos) {
    if (repo.missing) continue;
    for (const wt of repo.worktrees) {
      out.push({
        id: `wt:${wt.path}`,
        kind: "worktree",
        title: wt.name,
        detail: `${repo.shortName} · ${wt.branch ?? ctx.detached}`,
        keywords: [wt.path, `${repo.shortName}/${wt.branch ?? ""}`],
        status: ctx.dot(wt.path),
        activity: ctx.activity(wt.path),
        worktree: wt.path,
        run: () => ctx.onPick(wt),
      });
    }
  }
  return out;
}

export function tabItems(
  repos: RepoView[],
  tabsOf: (path: string) => Tab[],
  ctx: { name(tab: Tab): string; attention?: (id: string) => Attention | null; onPick(tab: Tab): void },
): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const repo of repos) {
    if (repo.missing) continue;
    for (const wt of repo.worktrees) {
      for (const tab of tabsOf(wt.path)) {
        out.push({
          id: `tab:${tab.id}`,
          kind: "tab",
          title: ctx.name(tab),
          detail: `${repo.shortName} / ${wt.name}`,
          keywords: [tab.agent ? "agent" : "terminal"],
          status: ctx.attention?.(tab.id) ?? tab.status,
          worktree: wt.path,
          order: out.length,
          run: () => ctx.onPick(tab),
        });
      }
    }
  }
  return out;
}

export function settingItems(t: T, onPick: (id: string) => void): PaletteItem[] {
  return SECTIONS.map((s) => ({
    id: `set:${s.id}`,
    kind: "setting" as const,
    title: t(s.labelKey),
    detail: t("settings.title"),
    keywords: [s.id],
    run: () => onPick(s.id),
  }));
}

export type ActionName =
  | "newWorktree"
  | "newAgentTab"
  | "newShellTab"
  | "addRepo"
  | "openSettings"
  | "searchDocs"
  | "toggleSidebar"
  | "showDocs"
  | "stageAll"
  | "discardAll";

const ORDER: ActionName[] = ["newWorktree", "newAgentTab", "newShellTab", "addRepo", "openSettings", "searchDocs", "toggleSidebar", "showDocs", "stageAll", "discardAll"];
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const HINTS: Partial<Record<ActionName, string>> = {
  searchDocs: MAC ? "⌘ K" : "Ctrl K",
  // The same chords the keymap binds.
  newAgentTab: chordLabel("agent.new") ?? undefined,
  newShellTab: chordLabel("tab.new") ?? undefined,
};

/** The app actions that have a handler; an action that cannot run now is not listed. */
export function actionItems(t: T, acts: Partial<Record<ActionName, () => void>>): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const name of ORDER) {
    const run = acts[name];
    if (!run) continue;
    out.push({
      id: `act:${name}`,
      kind: "action",
      title: t(`palette.action.${name}`),
      keywords: t(`palette.action.${name}.keywords`).split(/\s+/).filter(Boolean),
      hint: HINTS[name],
      run,
    });
  }
  return out;
}

/** The same check as the create-worktree dialog. */
export function validWorktreeName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !/\s/.test(n) && !n.includes("..") && !n.startsWith("-");
}
