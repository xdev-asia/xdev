import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { useProfiles, profileName } from "@/agents/profileStore";
import type { QuickCommand, RepoView, SessionRow, Task, WorktreeView } from "@/api";
import type { AgentSessionsStore } from "@/agentSessions/store";
import { useI18n } from "@/i18n";
import { getQuickCommands, selectCommands, subscribeQuickCommands } from "@/quickCommands/store";
import { copyContext } from "@/terminal/terminalActions";
import { terminalOf } from "@/terminal/terminalRegistry";
import type { Sessions } from "@/workspace/sessions";
import { openCrashDialog } from "@/crash/crashEvents";
import { missionItems } from "@/orchestration/missionEvents";
import { actionItems, crashItems, quickCommandItems, settingItems, tabItems, worktreeItems, type ActionName, type Attention, type PaletteItem } from "./items";
import { JumpPalette } from "./JumpPalette";
import { chatItems, taskItems } from "./moreItems";
import { RecentStore } from "./recent";
import { conversationItems } from "@/conversation/conversationStore";

/** What the palette can make the shell do; the shell supplies each one. */
export interface PaletteActions {
  /** Selects the worktree and shows the workspace view. */
  selectWorktree(wt: WorktreeView): void;
  /** Brings a tab to the front of its worktree. */
  frontTab(worktree: string, id: string): void;
  /** Shows the workspace view, leaving settings or docs. */
  showWorkspace(): void;
  openSettings(section?: string, target?: string): void;
  newWorktree(name?: string): void;
  addRepo(): void;
  searchDocs(): void;
  toggleSidebar(): void;
  showDocs(): void;
  /** Stage every change of the selected worktree; absent when it has no changes panel. */
  stageAllChanges?(): void;
  /** Opens the discard confirm for every change of the selected worktree. */
  discardAllChanges?(): void;
  /** Opens the sessions panel with the search box focused. */
  openSessions?(): void;
  /** Resumes a past chat, of any worktree, in a new agent tab of its worktree. */
  resumeSession?(row: SessionRow): void;
  /** Opens Docs > Tasks on one task. */
  openTask?(id: string): void;
  /** Runs a saved quick command in the current worktree. */
  runQuickCommand?(cmd: QuickCommand): void;
  /** Opens the new quick command dialog. */
  newQuickCommand?(): void;
}

export interface PaletteHostProps {
  open: boolean;
  onClose(): void;
  repos: RepoView[] | null;
  sessions: Sessions | null;
  current: WorktreeView | null;
  /** The tab in front of the current worktree. */
  shownTab: string | null;
  /** Optional: what an agent wants from the person, so those tabs rank first. */
  attention?: (tabId: string) => Attention | null;
  /** Optional: the agent session list, for the past chats. */
  history?: AgentSessionsStore | null;
  /** Optional: the agent task list, read each time the palette opens. */
  tasks?: () => Promise<Task[]>;
  actions: PaletteActions;
}

const NO_ROWS: SessionRow[] = [];
const NO_TASKS: Task[] = [];
const FALLBACK_AGENT = "claude";
const FALLBACK_SHELL = "shell";

/** Turns the shell's state into palette items and keeps the recency of what was visited. */
export function PaletteHost(props: PaletteHostProps): JSX.Element {
  const { open, repos, sessions, current, shownTab, attention, actions } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [recent] = useState(() => new RecentStore());
  const history = props.history ?? null;
  const rows = useSyncExternalStore(
    (listener) => (history ? history.subscribe(listener) : () => {}),
    () => history?.state.rows ?? NO_ROWS,
    () => NO_ROWS,
  );
  // A palette that opens reads the logs once, so a session that just ended is in the list.
  useEffect(() => {
    if (open) void history?.refresh();
  }, [open, history]);

  // The task list is read as the palette opens; a failure (no Docs vault, say) leaves it empty.
  const [taskRows, setTaskRows] = useState<Task[]>(NO_TASKS);
  // The reader is kept in a ref: the shell passes a new arrow each render, and the list is read
  // once per opening, not once per render.
  const readTasks = props.tasks;
  const readRef = useRef(readTasks);
  readRef.current = readTasks;
  const canReadTasks = !!readTasks;
  useEffect(() => {
    const read = readRef.current;
    if (!open || !read) return;
    let live = true;
    read().then(
      (found) => live && setTaskRows(found),
      () => live && setTaskRows(NO_TASKS),
    );
    return () => {
      live = false;
    };
  }, [open, canReadTasks]);

  const currentPath = current?.path ?? null;
  const quick = useSyncExternalStore(subscribeQuickCommands, getQuickCommands, getQuickCommands);
  useEffect(() => {
    if (currentPath) recent.touch(`wt:${currentPath}`);
  }, [currentPath]);
  useEffect(() => {
    if (shownTab && !shownTab.startsWith("file:")) recent.touch(`tab:${shownTab}`);
  }, [shownTab]);

  const list = repos ?? [];
  const usable = list.some((r) => !r.missing);

  function openTab(profile: string): void {
    if (!sessions || !current) return;
    actions.showWorkspace();
    const tab = sessions.open(current.path, profile);
    actions.frontTab(current.path, tab.id);
  }

  let items: PaletteItem[] = [];
  if (open) {
    const handlers: Partial<Record<ActionName, () => void>> = {
      newWorktree: usable ? () => actions.newWorktree() : undefined,
      newAgentTab: sessions && current ? () => openTab(view?.defaultAgent ?? FALLBACK_AGENT) : undefined,
      newShellTab: sessions && current ? () => openTab(view?.shells[0]?.id ?? FALLBACK_SHELL) : undefined,
      addRepo: () => actions.addRepo(),
      openSettings: () => actions.openSettings(),
      searchDocs: () => actions.searchDocs(),
      toggleSidebar: () => actions.toggleSidebar(),
      showDocs: () => actions.showDocs(),
      stageAll: current && actions.stageAllChanges ? () => actions.stageAllChanges?.() : undefined,
      resumeSession: actions.openSessions ? () => actions.openSessions?.() : undefined,
      discardAll: current && actions.discardAllChanges ? () => actions.discardAllChanges?.() : undefined,
    };
    // The tab in front, when it is a terminal: the same calls as the tab and terminal menus.
    const front = sessions && current && shownTab ? sessions.tabs(current.path).find((x) => x.id === shownTab) : undefined;
    if (sessions && current && front) {
      handlers.pinTab = front.pinned ? undefined : () => sessions.setPinned(front.id, true);
      handlers.unpinTab = front.pinned ? () => sessions.setPinned(front.id, false) : undefined;
      handlers.moveTabRight = sessions.canMoveToSplit(front.id) ? () => sessions.moveToSplit(front.id, "right") : undefined;
      const handle = terminalOf(front.id);
      if (handle) {
        const profile = profileName(view, front.profileId, t);
        handlers.clearTerminal = () => handle.clear();
        handlers.resetTerminal = () => handle.reset();
        handlers.copyTerminalContext = () =>
          void copyContext(handle, { title: front.title ?? profile, profile, path: current.path, branch: current.branch, exitCode: front.exitCode });
      }
    }
    const repoOfCurrent = list.find((r) => r.worktrees.some((w) => w.path === currentPath));
    const picked = selectCommands(quick, repoOfCurrent?.path ?? null);
    // A chat that a live tab already shows is left out of the past chats.
    const liveSessions = new Set(
      list.flatMap((r) => r.worktrees).flatMap((w) => sessions?.tabs(w.path) ?? []).flatMap((tab) => [tab.agentSession, tab.resumeOf]).filter((id): id is string => !!id),
    );
    const isLive = (row: SessionRow) => liveSessions.has(row.session.id);
    const worktreeOf = (path: string) => list.flatMap((r) => r.worktrees).find((w) => w.path === path);
    items = [
      ...tabItems(list, (path) => sessions?.tabs(path) ?? [], {
        name: (tab) => profileName(view, tab.profileId, t),
        attention,
        onPick: (tab) => {
          const wt = worktreeOf(tab.worktree);
          if (!wt) return;
          actions.selectWorktree(wt);
          actions.frontTab(wt.path, tab.id);
        },
      }),
      ...worktreeItems(list, {
        dot: (path) => sessions?.dot(path) ?? null,
        activity: (path) => sessions?.lastActivity(path) ?? null,
        detached: t("workspace.detached"),
        onPick: (wt) => actions.selectWorktree(wt),
      }),
      ...settingItems(t, (id, target) => (target ? actions.openSettings(id, target) : actions.openSettings(id))),
      ...actionItems(t, handlers),
      ...crashItems(t, () => openCrashDialog({ latest: true })),
      ...missionItems(t),
      ...conversationItems(t, front),
      ...(current && actions.runQuickCommand && actions.newQuickCommand
        ? quickCommandItems([...picked.global, ...picked.project], repoOfCurrent?.shortName ?? "", t, { run: actions.runQuickCommand, create: actions.newQuickCommand })
        : []),
      ...(actions.resumeSession ? chatItems(rows.filter((r) => !isLive(r)), list, t, actions.resumeSession) : []),
      ...(readTasks && actions.openTask ? taskItems(taskRows, list, t, actions.openTask) : []),
    ];
  }

  return (
    <JumpPalette
      open={open}
      items={items}
      current={{ worktree: currentPath, tab: shownTab }}
      recent={recent}
      scopes={list.filter((r) => !r.missing).map((r) => ({ path: r.path, name: r.shortName }))}
      canCreate={usable}
      onCreate={(name) => actions.newWorktree(name)}
      onClose={props.onClose}
    />
  );
}
