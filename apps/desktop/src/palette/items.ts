import { chordLabel } from "@/keys/keymap";
import type { BoardTask, QuickCommand, RepoView, WorktreeView } from "@/api";
import { entriesFor } from "@/settings/catalog";
import { SECTIONS } from "@/settings/sections";
import type { Tab } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";

export type PaletteKind = "tab" | "chat" | "worktree" | "task" | "file" | "setting" | "action";
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
  /** The repo folder, for the project scope. Settings and actions have none. */
  repo?: string;
  /** Tabs: the position in open order, for stable ordering. */
  order?: number;
  /** Left out until the trimmed query has at least this many characters. */
  minQuery?: number;
  run(): void;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The shortest query that lists files: one letter would match most of a repo. */
export const FILE_MIN_QUERY = 2;

/** Files of the current worktree: the name, then the folder it is in. */
export function fileItems(rels: readonly string[], worktree: string, repo: string | undefined, onPick: (rel: string) => void): PaletteItem[] {
  return rels.map((rel) => {
    const cut = rel.lastIndexOf("/");
    return {
      id: `file:${rel}`,
      kind: "file" as const,
      title: cut < 0 ? rel : rel.slice(cut + 1),
      detail: cut < 0 ? undefined : rel.slice(0, cut),
      keywords: [rel],
      worktree,
      repo,
      minQuery: FILE_MIN_QUERY,
      run: () => onPick(rel),
    };
  });
}

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
        repo: repo.path,
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
          repo: repo.path,
          order: out.length,
          run: () => ctx.onPick(tab),
        });
      }
    }
  }
  return out;
}

/** Settings entries show once the query has this many characters, to keep the empty palette short. */
export const SETTING_ENTRY_MIN_QUERY = 2;

export function settingItems(t: T, onPick: (section: string, target?: string) => void): PaletteItem[] {
  const sectionTitle = (id: string) => t(SECTIONS.find((s) => s.id === id)?.labelKey ?? id);
  const sections: PaletteItem[] = SECTIONS.map((s) => ({
    id: `set:${s.id}`,
    kind: "setting" as const,
    title: t(s.labelKey),
    detail: t("settings.title"),
    keywords: [s.id],
    run: () => onPick(s.id),
  }));
  const entries: PaletteItem[] = entriesFor().map((e) => ({
    id: `set:${e.id}`,
    kind: "setting" as const,
    title: t(e.titleKey),
    detail: sectionTitle(e.section),
    keywords: [...e.keywords],
    minQuery: SETTING_ENTRY_MIN_QUERY,
    run: () => onPick(e.section, e.id),
  }));
  return [...sections, ...entries];
}

export type ActionName =
  | "newWorktree"
  | "newAgentTab"
  | "newShellTab"
  | "newBrowserTab"
  | "addRepo"
  | "openSettings"
  | "searchDocs"
  | "toggleSidebar"
  | "showDocs"
  | "captureScreen"
  | "annotateClipboard"
  | "resumeSession"
  | "stageAll"
  | "discardAll"
  | "pinTab"
  | "unpinTab"
  | "moveTabRight"
  | "clearTerminal"
  | "resetTerminal"
  | "copyTerminalContext"
  | "newTask"
  | "runTargets"
  | "openServerShell"
  | "getPro"
  | "activatePro"
  | "refreshLicense"
  | "remoteAdd"
  | "remoteReconnect"
  | "replayTour"
  | "openTaskBoard"
  | "decomposeGoal";

const ORDER: ActionName[] = ["newWorktree", "newAgentTab", "newShellTab", "newBrowserTab", "addRepo", "openSettings", "searchDocs", "toggleSidebar", "showDocs", "captureScreen", "annotateClipboard", "resumeSession", "stageAll", "discardAll", "pinTab", "unpinTab", "moveTabRight", "clearTerminal", "resetTerminal", "copyTerminalContext", "newTask", "openTaskBoard", "decomposeGoal", "runTargets", "openServerShell", "getPro", "activatePro", "refreshLicense", "remoteAdd", "remoteReconnect", "replayTour"];
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const HINTS: Partial<Record<ActionName, string>> = {
  searchDocs: MAC ? "⌘ K" : "Ctrl K",
  // The same chords the keymap binds.
  newAgentTab: chordLabel("agent.new") ?? undefined,
  newShellTab: chordLabel("tab.new") ?? undefined,
  newBrowserTab: chordLabel("browser.new") ?? undefined,
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

/** "Show last crash report": opens the crash dialog with the latest report of any status. */
export function crashItems(t: T, open: () => void): PaletteItem[] {
  return [
    {
      id: "crash:last",
      kind: "action",
      title: t("palette.crash.last"),
      keywords: t("palette.crash.last.keywords").split(/\s+/).filter(Boolean),
      run: open,
    },
  ];
}

/** The same check as the create-worktree dialog. */
export function validWorktreeName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !/\s/.test(n) && !n.includes("..") && !n.startsWith("-");
}

/**
 * One "Run: {label}" item per quick command visible in the worktree (the caller passes the global
 * ones and those of its repo), plus "New quick command…". The scope is the detail.
 */
export function quickCommandItems(
  cmds: readonly QuickCommand[],
  repoName: string,
  t: T,
  acts: { run(cmd: QuickCommand): void; create(): void },
): PaletteItem[] {
  const runs = cmds.map((cmd): PaletteItem => ({
    id: `qcmd:${cmd.id}`,
    kind: "action",
    title: t("qcmd.palette.run", { label: cmd.label }),
    detail: cmd.scope.type === "global" ? t("qcmd.section.global") : repoName,
    keywords: ["quick", "command", cmd.label],
    run: () => acts.run(cmd),
  }));
  const create: PaletteItem = {
    id: "qcmd:new",
    kind: "action",
    title: t("qcmd.palette.new"),
    keywords: ["quick", "command", "new", "create"],
    run: acts.create,
  };
  return [...runs, create];
}

/** The tasks of the current repo's board as palette items; picking one opens the board and its editor. */
export function boardTaskItems(tasks: readonly BoardTask[], t: T, repo: string, open: (id: string) => void): PaletteItem[] {
  return tasks.map((task): PaletteItem => ({
    id: `ftask:${task.id}`,
    kind: "task",
    title: task.title,
    detail: t(statusKeyOf(task.status)),
    keywords: [task.id, ...task.labels],
    repo,
    run: () => open(task.id),
  }));
}

const statusKeyOf = (s: BoardTask["status"]): string => `board.col.${s === "in-progress" ? "inProgress" : s === "in-review" ? "inReview" : s}`;
