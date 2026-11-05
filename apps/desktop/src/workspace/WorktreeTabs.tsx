import { Button, EmptyState, IconButton } from "@xdev-asia/ui";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import { type Api, type ApiError, type PtyProfile } from "@/api";
import { FileView } from "@/files/FileView";
import { fileName, fileTabId, fileTabRel, fileTabs, isDirty, isFileTab, useOpenFiles } from "@/files/fileTabs";
import { saveFile } from "@/files/fileIO";
import { MarkdownPreview } from "@/files/MarkdownPreview";
import { isPreviewTab, previewTabId, previewTabRel } from "@/files/previewTabs";
import { viewerOf } from "@/files/viewer";
import { UnsavedDialog } from "@/files/UnsavedDialog";
import { useI18n } from "@/i18n";
import { useKeymap } from "@/keys/keymap";
import { useNavigationSettings } from "@/settings/navigationSettings";
import { useUsageSettings } from "@/settings/usageSettings";
import { useCacheTimers } from "./cacheTimer";
import { buildSections } from "@/quickCommands/model";
import { QuickCommandsControl } from "@/quickCommands/QuickCommandsControl";
import { runWithToast } from "@/quickCommands/runUi";
import { getQuickCommands, selectCommands } from "@/quickCommands/store";
import { quickCommandsSubmenu } from "@/quickCommands/submenu";
import { ReviewView } from "@/review/ReviewView";
import { Terminal, type TerminalHandle } from "@/terminal/Terminal";
import { CONTEXT_LINES, copyContext, copyText } from "@/terminal/terminalActions";
import { handoffPrompt, sourceFirstPrompt } from "@/agentSessions/handoff";
import { HandOffDialog, type HandOffChoice } from "@/agentSessions/HandOffDialog";
import { sendToOpenedTab } from "./agentPrompt";
import { pushToast } from "./toastStore";
import { terminalMenuItems } from "@/terminal/terminalMenu";
import { registerTerminal } from "@/terminal/terminalRegistry";
import { useApprovedStart } from "@/terminal/useApprovedStart";
import { ContextMenu } from "@/ui/ContextMenu";
import {
  addTab,
  equalize,
  focusPane,
  leaves,
  neighbour,
  paneOf,
  removeTab,
  resize,
  selectTab,
  single,
  splitPane,
  toggleExpand,
  type PaneDir,
  type PaneLayout,
  type PaneNode,
} from "./paneTree";
import { CloseTabsDialog } from "./CloseTabsDialog";
import { bodyStyle, PaneView, paneRects } from "./PaneView";
import { CommitView, type CommitAsk } from "./CommitView";
import { cliOf, ownAccount, type Sessions, type Tab, type TabCli } from "./sessions";
import type { SetupGate } from "./setupGate";
import { TabStrip, type MenuGroup, type StripItem } from "./TabStrip";
import { cycleTab, mruOrder, nthTab } from "./tabNav";
import { TabTitleDialog } from "./TabTitleDialog";
import { titleStatus } from "./titles";
import { PtydBanner } from "@/terminal/PtydBanner";
import { WorkerStrip } from "./WorkerStrip";

// Offered while the profile view has not loaded: the built-in agents and the default shell.
const FALLBACK_AGENTS: readonly PtyProfile[] = ["claude", "codex"];
const FALLBACK_SHELL: PtyProfile = "shell";

// Only an exit ends a tab; a turn that failed (status failed) still has its pty.
const ended = (tab: Tab) => tab.exitCode !== undefined;

// An agent that is busy or waiting for the person; nothing tells whether a plain shell has a child process.
const running = (tab: Tab) => tab.agent && !ended(tab) && (tab.status === "working" || tab.status === "needs-you");

type CloseReason = "running" | "pinned";

// The review tab's id; terminal tabs use their pty id, which never has a colon.
const REVIEW_TAB = "review:";
// The commit tab's id: one per worktree, pointed at the last commit asked for, never restored.
const COMMIT_TAB = "commit:";

type Leaf = Extract<PaneNode, { kind: "leaf" }>;

/** A file to show in the review tab; a new `seq` asks for it again. */
export type Reveal = { file: string; seq: number };

// Ctrl+Tab keeps walking the same list until the focus has rested this long (R4).
export const MRU_SETTLE_MS = 600;

/**
 * The terminal tabs of one worktree, laid out as a tree of panes. Every terminal stays mounted while
 * its tab is open, in one flat list keyed by tab id: a pane only reserves the area a terminal is
 * placed in, so moving or resizing panes never remounts xterm. The shell keeps one of these per
 * visited worktree and hides the ones not selected. The review tab sits in a pane like any tab.
 */
export function WorktreeTabs(props: {
  api: Api;
  sessions: Sessions;
  worktree: string;
  /** The branch of the worktree, for Copy Context; null when detached or unknown. */
  branch?: string | null;
  visible: boolean;
  reveal?: Reveal;
  /** A commit to show in the commit tab; a new `seq` opens it again, on this commit. */
  commit?: CommitAsk;
  /** Brings a terminal tab to the front; a new `seq` is a new request. */
  front?: { id: string; seq: number };
  /** Told which tab is in front, so the shell knows where a prompt from the Agent kit goes. */
  onShown?: (id: string | null) => void;
  /** Told which terminal panes are on screen (the front tab of each pane), so the shell knows what is seen. */
  onPanes?: (ids: string[]) => void;
  /** A new value puts keyboard focus in the terminal in front. */
  focusSeq?: number;
  /** Shows a session in the session history panel. */
  onShowHistory?: (sessionId: string) => void;
  /** Holds agent launches while this worktree's setup tab runs. */
  gate?: SetupGate;
  /** The repo registry key of the worktree and its short name, for the quick commands. */
  repo?: string | null;
  repoName?: string;
  /** A new value opens the Command popover of the focused pane. */
  quickSeq?: number;
  onManageQuickCommands?: () => void;
  /** Every worktree, for the hand off dialog's picker. */
  worktrees?: { path: string; label: string }[];
  /** Brings a tab of any worktree to the front; used after a hand off to another worktree. */
  onJump?(tabId: string): void;
}): JSX.Element {
  const { api, sessions, worktree, visible, reveal } = props;
  const { t } = useI18n();
  const navigation = useNavigationSettings();
  // A Ctrl+Tab walk in progress: the frozen MRU list and where in it the focus is.
  const [walk] = useState(() => ({ current: null as { list: string[]; at: number; timer: ReturnType<typeof setTimeout> } | null }));
  // The pane whose `+` menu is open.
  const [menuPane, setMenuPane] = useState<string | null>(null);
  // A close that waits for a yes: what it asks about, and what to do on confirm; null when nothing waits.
  const [closing, setClosing] = useState<{ reason: CloseReason; run: () => void } | null>(null);
  // The tab whose title dialog is open, and the terminal menu (tab, pointer, that terminal's handle).
  const [titling, setTitling] = useState<string | null>(null);
  // The hand off dialog: the source tab and its terminal text, read when the menu item was picked.
  const [handingOff, setHandingOff] = useState<{ id: string; lines: string[] } | null>(null);
  const [termMenu, setTermMenu] = useState<{ id: string; at: { x: number; y: number }; handle: TerminalHandle } | null>(null);
  // Bumped when a key moves focus, so the terminal in front takes the keyboard.
  const [kick, setKick] = useState(0);
  // Views started per tab; a retry after approval mounts a fresh view on the same pty id.
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const { ask, error, setError, dialog } = useApprovedStart(api);
  // The one review tab; a reveal opens it (or points it at another file).
  const [review, setReview] = useState<Reveal | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [fronted, setFronted] = useState(0);
  // The one commit tab; an ask opens it (or points it at another commit).
  const [commitAsk, setCommitAsk] = useState<CommitAsk | null>(null);
  const [commitSeen, setCommitSeen] = useState(0);

  const subscribe = useCallback((listener: () => void) => sessions.subscribe(listener), [sessions]);
  const snapshot = () => sessions.tabs(worktree);
  const tabs = useSyncExternalStore(subscribe, snapshot, snapshot);
  const usage = useUsageSettings();
  // Seen from the outside: the transitions of the tabs' status, not a time read from the agent.
  const cacheTimers = useCacheTimers(tabs, usage.cacheTimer);
  const layoutSnapshot = () => sessions.layout(worktree);
  const stored = useSyncExternalStore(subscribe, layoutSnapshot, layoutSnapshot);

  // A reveal opens the review tab; taken during render, so the frame that asks for a file already has it.
  let open = review;
  if (reveal && reveal.seq !== revealed) {
    open = reveal;
    setRevealed(reveal.seq);
    setReview(open);
  }
  let commitOpen = commitAsk;
  if (props.commit && props.commit.seq !== commitSeen) {
    commitOpen = props.commit;
    setCommitSeen(commitOpen.seq);
    setCommitAsk(commitOpen);
  }
  // The layout with a tab in or out of it: the same object when nothing changes. The store catches up
  // in the effect below.
  const withTab = (base: PaneLayout | null, id: string, on: boolean): PaneLayout | null =>
    on ? (base ? addTab(base, id) : single(id)) : base && paneOf(base, id) ? removeTab(base, id) : base;
  const withReview = withTab(withTab(stored, REVIEW_TAB, open !== null), COMMIT_TAB, commitOpen !== null);
  // The same for file tabs: the open files of the store are the tabs; a closed one leaves its pane.
  const files = useOpenFiles(worktree);
  const fileIds = new Set(files.map((f) => fileTabId(f.rel)));
  let layout: PaneLayout | null = withReview;
  for (const leaf of layout ? (leaves(layout) as Leaf[]) : []) {
    for (const id of leaf.tabs) {
      // A preview goes with its source: a file that is closed, or never opened, leaves no preview behind.
      const gone = isFileTab(id) ? !fileIds.has(id) : isPreviewTab(id) && !fileIds.has(fileTabId(previewTabRel(id)!));
      if (gone && layout) layout = removeTab(layout, id);
    }
  }
  for (const id of fileIds) layout = layout ? addTab(layout, id) : single(id);
  useEffect(() => {
    if (layout !== stored) sessions.setLayout(worktree, layout);
  }, [layout, stored, sessions, worktree]);

  // What the shell reads: the front tab of the focused pane, and the front tab of every pane on screen.
  const rects = layout ? paneRects(layout) : {};
  const panes = layout ? (leaves(layout) as Leaf[]) : [];
  const focusedLeaf = panes.find((n) => n.id === layout?.focused);
  const shown = focusedLeaf?.active ?? null;
  const frontIds = new Set(panes.filter((n) => n.id in rects).map((n) => n.active));
  // A restored tab that sits behind another starts its terminal only when it is first at the front of
  // a pane (Q2); every other tab starts at once.
  const [everFront] = useState(() => new Set<string>());
  for (const id of frontIds) everFront.add(id);
  // A string, so the shell hears only when the set on screen changes.
  const paneKey = [...frontIds].filter((id) => id !== REVIEW_TAB && id !== COMMIT_TAB && !isFileTab(id) && !isPreviewTab(id)).join(" ");
  const { onShown, onPanes, front } = props;
  useEffect(() => onShown?.(shown), [shown]);
  // The focus order for MRU; a walk records only where it ends, not the tabs it passed (R4).
  const [shownNow] = useState(() => ({ current: shown }));
  shownNow.current = shown;
  useEffect(() => {
    if (shown && !walk.current) sessions.noteFocused(worktree, shown);
  }, [shown, sessions, worktree]);
  useEffect(() => onPanes?.(paneKey ? paneKey.split(" ") : []), [paneKey]);

  // The shell asks for a tab to come to the front, and a reveal for the review tab to.
  useEffect(() => {
    if (!front || front.seq === fronted) return;
    setFronted(front.seq);
    if (layout) sessions.setLayout(worktree, selectTab(layout, front.id));
  }, [front?.seq]);
  useEffect(() => {
    if (reveal && layout && paneOf(layout, REVIEW_TAB)) sessions.setLayout(worktree, selectTab(layout, REVIEW_TAB));
  }, [reveal?.seq]);
  useEffect(() => {
    if (props.commit && layout && paneOf(layout, COMMIT_TAB)) sessions.setLayout(worktree, selectTab(layout, COMMIT_TAB));
  }, [props.commit?.seq]);

  const { view } = useProfiles();
  // The CLI a profile runs, from the profile view; the built-in ids stand in until it loads.
  const cliFor = (id: PtyProfile): TabCli => {
    const found = view?.profiles.find((p) => p.profile.id === id);
    if (!found) return cliOf(id);
    const cli = found.profile.cli;
    return cli === "claude" || cli === "codex" ? cli : null;
  };
  // The `+` menu: agents that are on and installed, then every shell on offer.
  const agents = view ? view.profiles.filter((p) => p.profile.enabled && p.installed).map((p) => p.profile.id) : FALLBACK_AGENTS;
  const shells = view ? view.shells.map((s) => s.id) : [FALLBACK_SHELL];
  const groups: MenuGroup[] = [
    { label: t("workspace.tabs.agents"), ids: [...agents] },
    { label: t("workspace.tabs.shells"), ids: shells },
  ].filter((g) => g.ids.length > 0);
  // The default shell: the profile view's, else its first; null when none is on.
  const defaultShell: PtyProfile | null = view
    ? shells.includes(view.defaultShell)
      ? view.defaultShell
      : (shells[0] ?? null)
    : FALLBACK_SHELL;

  const setLayout = (next: PaneLayout | null) => sessions.setLayout(worktree, next);

  // A new tab in `pane`: `open` puts it in the focused pane, so that one is focused first.
  function launch(profile: PtyProfile, pane?: string): Tab {
    setMenuPane(null);
    setError(null);
    const at = sessions.layout(worktree);
    if (pane && at && at.focused !== pane) setLayout(focusPane(at, pane));
    return sessions.open(worktree, profile, null, cliFor(profile));
  }

  // An agent launch waits for the setup tab when the gate says so; a shell never does.
  function launchGated(profile: PtyProfile, pane?: string): void {
    const agent = !profile.startsWith("shell") && !profile.startsWith("xdev:");
    if (agent && props.gate?.defer(worktree, () => void launch(profile, pane))) return;
    launch(profile, pane);
  }

  // A new pane beside `pane`, with a new terminal in it.
  function splitWith(pane: string, dir: PaneDir, profile: PtyProfile): void {
    const tab = launch(profile, pane);
    const now = sessions.layout(worktree);
    const without = now && removeTab(now, tab.id);
    if (without) setLayout(splitPane(without, pane, dir, tab.id));
  }

  // Moves a tab of `pane` into a new pane beside it. The only tab of a pane has nothing to leave.
  function splitTab(pane: string, id: string, dir: PaneDir): void {
    const leaf = panes.find((n) => n.id === pane);
    if (!layout || !leaf || leaf.tabs.length < 2) return;
    const without = removeTab(layout, id);
    if (without) setLayout(splitPane(without, pane, dir, id));
  }

  // The file tab whose Save / Don't Save / Cancel dialog is open.
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const io = { api, store: fileTabs, t };

  function closeTab(id: string): void {
    const rel = fileTabRel(id);
    if (rel !== null) {
      const entry = fileTabs.get(worktree, rel);
      if (entry && isDirty(entry)) return void setUnsaved(rel);
      return fileTabs.close(worktree, rel);
    }
    if (isPreviewTab(id)) return void (layout && setLayout(removeTab(layout, id)));
    if (id === COMMIT_TAB) {
      setCommitAsk(null);
      if (layout) setLayout(removeTab(layout, COMMIT_TAB));
      return;
    }
    if (id !== REVIEW_TAB) return void sessions.close(id);
    setReview(null);
    if (layout) setLayout(removeTab(layout, REVIEW_TAB));
  }

  const byId = new Map(tabs.map((tab) => [tab.id, tab]));

  // The Markdown file `rel` shows in the tab strip, if it is open and the viewer for it is Markdown.
  const markdownFile = (rel: string | null) => {
    const entry = rel === null ? undefined : files.find((f) => f.rel === rel);
    return entry && rel !== null && viewerOf(rel, entry.kind) === "markdown" ? entry : undefined;
  };

  // The preview of `rel`: in `pane` (the focused one by default), or in a new pane to its right.
  function openPreview(rel: string, opts: { pane?: string; side?: boolean } = {}): boolean {
    if (!layout || !markdownFile(rel)) return false;
    const id = previewTabId(rel);
    if (paneOf(layout, id)) setLayout(selectTab(layout, id));
    else if (opts.side) setLayout(splitPane(layout, opts.pane ?? layout.focused, "right", id));
    else setLayout(addTab(layout, id, opts.pane));
    return true;
  }

  // ---- Keys: they act on the focused pane ----------------------------------------------------

  // Puts `id` in front in its pane, focuses that pane, and gives its terminal the keyboard.
  function go(id: string): void {
    if (!layout) return;
    setLayout(selectTab(layout, id));
    setKick((k) => k + 1);
  }

  // A new tab of the default shell in the focused pane; with no shell on, the `+` menu of that pane.
  function newShell(): boolean {
    if (defaultShell === null) {
      if (!layout) return false;
      setMenuPane(layout.focused);
      return true;
    }
    launch(defaultShell);
    setKick((k) => k + 1);
    return true;
  }

  function closeNow(targets: string[]): void {
    for (const id of targets) closeTab(id);
  }

  // What closing `targets` has to ask about, with the navigation settings applied; null when nothing.
  function closeReason(targets: string[]): CloseReason | null {
    const found = targets.flatMap((id) => byId.get(id) ?? []);
    if (navigation.confirmCloseRunning && found.some(running)) return "running";
    if (navigation.confirmClosePinned && found.some((tab) => tab.pinned)) return "pinned";
    return null;
  }

  // Closes at once, unless a tab is pinned or runs an agent and its setting asks first. `run` is what a
  // yes does; Close Others and Close to the Right pass their own, since Sessions leaves pinned tabs out.
  function requestClose(targets: string[], run: () => void = () => closeNow(targets)): boolean {
    if (targets.length === 0) return false;
    const reason = closeReason(targets);
    if (reason) setClosing({ reason, run });
    else run();
    return true;
  }

  function stepTab(step: 1 | -1): boolean {
    const strip = focusedLeaf?.tabs ?? [];
    if (navigation.tabOrder !== "mru") {
      const to = cycleTab(strip, shown, step);
      if (to === null || to === shown) return false;
      go(to);
      return true;
    }
    // MRU: the list is taken when the walk starts and kept until the focus settles.
    const held = walk.current;
    const list = held?.list ?? mruOrder(strip, sessions.recentTabs(worktree));
    const from = held ? held.at : shown === null ? -1 : list.indexOf(shown);
    const to = cycleTab(list, from < 0 ? null : list[from], step);
    if (to === null || to === shown) return false;
    clearTimeout(held?.timer);
    walk.current = {
      list,
      at: list.indexOf(to),
      timer: setTimeout(() => {
        walk.current = null;
        if (shownNow.current) sessions.noteFocused(worktree, shownNow.current);
      }, MRU_SETTLE_MS),
    };
    go(to);
    return true;
  }

  function pickTab(n: number): boolean {
    const to = nthTab(focusedLeaf?.tabs ?? [], n);
    if (to === null) return false;
    go(to);
    return true;
  }

  function splitKey(dir: PaneDir): boolean {
    if (!layout || defaultShell === null) return false;
    splitWith(layout.focused, dir, defaultShell);
    setKick((k) => k + 1);
    return true;
  }

  // Focus moves to the next pane in reading order; an expansion follows it (focusPane does that).
  function movePane(step: 1 | -1): boolean {
    if (!layout) return false;
    const to = neighbour(layout, layout.focused, step);
    if (to === layout.focused) return false;
    setLayout(focusPane(layout, to));
    setKick((k) => k + 1);
    return true;
  }

  // Expand or equalize: taken whenever there are panes, even when nothing changes.
  function reshape(fn: (l: PaneLayout) => PaneLayout): boolean {
    if (!layout) return false;
    setLayout(fn(layout));
    return true;
  }

  // Taken in the capture phase so the terminal under focus does not also get the key. This
  // worktree listens only while it is on screen. A handler that returns false lets the key on.
  const defaultAgent = view?.defaultAgent ?? FALLBACK_AGENTS[0];
  useKeymap(
    {
      "agent.new": () => void launchGated(defaultAgent),
      "tab.new": () => newShell(),
      "tab.reopenClosed": () => sessions.reopenClosed(worktree) !== null,
      "tab.close": () => requestClose(shown ? [shown] : []),
      "tab.next": () => stepTab(1),
      "tab.prev": () => stepTab(-1),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.select.${n}`, () => pickTab(n)])),
      "pane.splitRight": () => splitKey("right"),
      "pane.splitDown": () => splitKey("down"),
      "pane.next": () => movePane(1),
      "pane.prev": () => movePane(-1),
      "pane.expand": () => reshape((l) => toggleExpand(l, l.focused)),
      "pane.equalize": () => reshape(equalize),
      "pane.close": () => requestClose(focusedLeaf?.tabs ?? []),
      // Only a file tab takes the save key; anywhere else it goes on to its other owners.
      "file.markdownPreview": () => (shown ? openPreview(fileTabRel(shown) ?? "") : false),
      "file.save": () => {
        const rel = shown ? fileTabRel(shown) : null;
        if (rel === null) return false;
        void saveFile({ api, store: fileTabs, t }, worktree, rel);
        return true;
      },
    },
    { when: () => visible },
  );

  function failed(tab: Tab, e: ApiError): void {
    const tries = attempts[tab.id] ?? 0;
    ask(
      tab.profileId,
      e,
      tries > 0,
      () => setAttempts((a) => ({ ...a, [tab.id]: (a[tab.id] ?? 0) + 1 })),
      // A tab whose pty never started has nothing to show; the reason stays in the banner.
      () => void sessions.close(tab.id),
      ownAccount(tab),
      tab.forkOf ?? tab.resumeOf ?? undefined,
      tab.forkOf !== null,
    );
  }

  // A claude or codex tab can fork once its session id is known.
  const forkable = (tab: Tab): boolean => tab.agent && (tab.cli === "claude" || tab.cli === "codex");
  function forkSession(tab: Tab): void {
    if (!tab.agentSession) return;
    setMenuPane(null);
    setError(null);
    sessions.fork(worktree, tab.profileId, ownAccount(tab), tab.agentSession, tab.title, tab.cli);
  }

  // Opens an agent in `choice.worktree` and types the source's state into it once it has started.
  async function handOff(source: Tab, lines: string[], choice: HandOffChoice): Promise<void> {
    const firstPrompt = await sourceFirstPrompt(api, worktree, source.agentSession);
    const text = handoffPrompt({
      fromProfile: profileName(view, source.profileId, t),
      worktree,
      branch: props.branch ?? null,
      firstPrompt,
      lines,
    });
    const opened = sessions.open(choice.worktree, choice.profileId, null, cliFor(choice.profileId));
    props.onJump?.(opened.id);
    const sent = await sendToOpenedTab(sessions, choice.worktree, opened.id, text);
    pushToast({ text: sent ? t("agentFork.handedOff") : t("agentFork.notReady") });
  }

  function again(tab: Tab): void {
    setError(null);
    sessions.restart(tab.id);
  }

  // The right-click menu of a terminal: its handle acts on the xterm, the rest on the tab and its pane.
  const termMenuItems = (tab: Tab, handle: TerminalHandle) => {
    const pane = layout ? paneOf(layout, tab.id) : null;
    const profile = profileName(view, tab.profileId, t);
    // Read when the menu opens, not as a hook: the strip's own control keeps the file commands loaded.
    const quickState = getQuickCommands();
    const quick = selectCommands(quickState, props.repo ?? null);
    const quickFile = quickState.files[worktree] ?? null;
    return terminalMenuItems({
      handle,
      tab,
      paneId: pane,
      split: (dir) => pane && defaultShell !== null && splitWith(pane, dir, defaultShell),
      setTitle: () => setTitling(tab.id),
      close: () => void requestClose([tab.id]),
      copyContext: () =>
        void copyContext(handle, {
          title: tab.title ?? profile,
          profile,
          path: worktree,
          branch: props.branch ?? null,
          exitCode: tab.exitCode,
        }),
      forkSession: forkable(tab) ? () => forkSession(tab) : undefined,
      handOff: forkable(tab) && props.worktrees ? () => setHandingOff({ id: tab.id, lines: handle.lines(CONTEXT_LINES) }) : undefined,
      copyTerminalId: () => void copyText(tab.id),
      copyPaneId: () => pane && void copyText(pane),
      quickCommands: quickCommandsSubmenu(
        buildSections(quick, quickFile, "", { hasTerminal: tab.exitCode === undefined, profiles: view ? view.profiles.map((p) => p.profile.id) : null }),
        (row) =>
          void runWithToast(
            api,
            row.cmd,
            { sessions, worktree, tab, trusted: quickFile?.trusted, profiles: view?.profiles.map((p) => p.profile.id), focus: () => handle.focus() },
            t,
          ),
      ),
    });
  };

  const stripOf = (leaf: Leaf) => {
    const items: StripItem[] = leaf.tabs.flatMap((id): StripItem[] => {
      if (id === REVIEW_TAB) return [{ id, tab: null }];
      const previewRel = previewTabRel(id);
      if (previewRel !== null) return [{ id, tab: null, preview: { rel: previewRel } }];
      if (id === COMMIT_TAB) return commitOpen ? [{ id, tab: null, commit: { id: commitOpen.id } }] : [];
      const rel = fileTabRel(id);
      if (rel !== null) {
        const entry = files.find((f) => f.rel === rel);
        return entry ? [{ id, tab: null, file: { rel, dirty: isDirty(entry) } }] : [];
      }
      const tab = byId.get(id);
      return tab ? [{ id, tab }] : [];
    });
    return (
      <TabStrip
        pane={leaf.id}
        items={items}
        cache={usage.cacheTimer ? { timers: cacheTimers, ttlMs: usage.cacheTtlMs } : undefined}
        active={leaf.active}
        groups={groups}
        menuOpen={menuPane === leaf.id}
        onMenu={(isOpen) => setMenuPane(isOpen ? leaf.id : null)}
        onSelect={(id) => layout && setLayout(selectTab(layout, id))}
        onClose={(id) => void requestClose([id])}
        onCloseOthers={(id) => {
          const rest = leaf.tabs.filter((t) => t !== id && !byId.get(t)?.pinned);
          requestClose(rest, () => sessions.closeOthers(id));
        }}
        onCloseToRight={(id) => {
          const rest = leaf.tabs.slice(leaf.tabs.indexOf(id) + 1).filter((t) => !byId.get(t)?.pinned);
          requestClose(rest, () => sessions.closeToRight(id));
        }}
        onLaunch={(profile) => launchGated(profile, leaf.id)}
        onSplit={(dir) => defaultShell !== null && splitWith(leaf.id, dir, defaultShell)}
        onMoveToSplit={(id, dir) => (id === REVIEW_TAB || isFileTab(id) || isPreviewTab(id) ? splitTab(leaf.id, id, dir) : sessions.moveToSplit(id, dir))}
        onPin={(id, pinned) => sessions.setPinned(id, pinned)}
        onCopyTabId={(id) => void copyText(id)}
        onChangeTitle={(id) => setTitling(id)}
        onColor={(id, color) => sessions.setColor(id, color)}
        onRename={(id, name) => sessions.rename(id, name)}
        onShowHistory={props.onShowHistory}
        trailing={
          <>
          {markdownFile(fileTabRel(leaf.active ?? "")) && (
            <IconButton icon="eye" label={t("files.preview.side")} onClick={() => openPreview(fileTabRel(leaf.active ?? "")!, { pane: leaf.id, side: true })} />
          )}
          <QuickCommandsControl
            api={api}
            sessions={sessions}
            worktree={worktree}
            repo={props.repo ?? null}
            repoName={props.repoName ?? ""}
            tab={leaf.active === REVIEW_TAB || leaf.active === COMMIT_TAB ? null : (byId.get(leaf.active ?? "") ?? null)}
            openSeq={layout?.focused === leaf.id ? props.quickSeq : undefined}
            onFocus={() => setKick((k) => k + 1)}
            onManage={() => props.onManageQuickCommands?.()}
          />
          </>
        }
      />
    );
  };
  // Where a tab's view sits: the body of its pane while it is that pane's front tab, else hidden.
  const placed = (id: string): { hidden: boolean; style?: ReturnType<typeof bodyStyle> } => {
    const pane = layout ? paneOf(layout, id) : null;
    const rect = pane ? rects[pane] : undefined;
    return rect && frontIds.has(id) ? { hidden: false, style: bodyStyle(rect) } : { hidden: true };
  };
  const reviewAt = placed(REVIEW_TAB);
  const commitAt = placed(COMMIT_TAB);

  return (
    <div className="ws-tabs" hidden={!visible}>
      <PtydBanner api={api} />
      {error && (
        <div className="banner banner-warn ws-tabs-banner" role="alert">
          <div className="banner-text">
            <span>{t(`error.${error.code}`)}</span>
            {error.detail && <pre className="commands">{error.detail}</pre>}
          </div>
        </div>
      )}

      <div className="ws-panes">
        {layout && (
          <PaneView
            layout={layout}
            strip={stripOf}
            onFocus={(pane) => layout.focused !== pane && setLayout(focusPane(layout, pane))}
            onResize={(split, sizes) => setLayout(resize(layout, split, sizes))}
            onEqualize={() => setLayout(equalize(layout))}
          />
        )}
        {tabs.map((tab) => {
          const at = placed(tab.id);
          return (
            <div
              key={tab.id}
              className="ws-tab-pane"
              role="tabpanel"
              data-tab={tab.id}
              hidden={at.hidden}
              style={at.style}
              onPointerDownCapture={() => {
                const pane = layout ? paneOf(layout, tab.id) : null;
                if (layout && pane && layout.focused !== pane) setLayout(focusPane(layout, pane));
              }}
            >
              {ended(tab) && (
                <div className="ws-tab-exit" role="status">
                  <span>
                    {tab.exitCode === null || tab.exitCode === undefined
                      ? t("terminal.exitedUnknown")
                      : t("terminal.exited", { code: tab.exitCode })}
                  </span>
                  <button type="button" className="ws-tab-again" onClick={() => again(tab)}>
                    {tab.agent ? t("workspace.tabs.restart") : t("workspace.tabs.again")}
                  </button>
                </div>
              )}
              <WorkerStrip api={api} tab={tab.id} running={running(tab)} />
              {tab.asleep && (
                <EmptyState
                  title={t("sleep.tab.title")}
                  hint={t(tab.agent ? "sleep.tab.hint" : "sleep.tab.hint.shell")}
                  actions={
                    <Button type="button" variant="primary" data-field="wake" onClick={() => sessions.wake(tab.id)}>
                      {t("sleep.wake")}
                    </Button>
                  }
                />
              )}
              {!tab.asleep && (everFront.has(tab.id) || !sessions.deferred(tab.id)) && <Terminal
                key={`${tab.id}:${attempts[tab.id] ?? 0}`}
                api={api}
                client={tab.client}
                id={tab.id}
                cwd={worktree}
                profile={tab.profileId}
                account={ownAccount(tab)}
                onStarted={(info) => sessions.noteStarted(tab.id, info)}
                onError={(e) => failed(tab, e)}
                onOutput={(bytes) => sessions.noteOutput(tab.id, bytes)}
                onInput={(text) => sessions.noteInput(tab.id, text)}
                onBell={() => sessions.noteBell(tab.id)}
                onTitle={(title) => {
                  sessions.noteTitle(tab.id, title);
                  const status = titleStatus(tab.cli, title);
                  if (status) sessions.noteTitleStatus(tab.id, status);
                }}
                focusSeq={tab.id === shown ? (props.focusSeq ?? 0) + kick : undefined}
                onMenu={(at, handle) => setTermMenu({ id: tab.id, at, handle })}
                handleRef={(handle) => {
                  registerTerminal(tab.id, handle);
                  return () => registerTerminal(tab.id, null);
                }}
              />}
            </div>
          );
        })}

        {files.map((file) => {
          const id = fileTabId(file.rel);
          const at = placed(id);
          return (
            <div
              key={id}
              className="ws-tab-pane"
              role="tabpanel"
              data-tab={id}
              hidden={at.hidden}
              style={at.style}
              onPointerDownCapture={() => {
                const pane = layout ? paneOf(layout, id) : null;
                if (layout && pane && layout.focused !== pane) setLayout(focusPane(layout, pane));
              }}
            >
              <FileView api={api} worktree={worktree} rel={file.rel} />
            </div>
          );
        })}

        {layout &&
          (leaves(layout) as Leaf[]).flatMap((leaf) =>
            leaf.tabs.flatMap((id) => {
              const rel = previewTabRel(id);
              const entry = rel === null ? undefined : files.find((f) => f.rel === rel);
              if (rel === null || !entry) return [];
              const at = placed(id);
              return [
                <div key={id} className="ws-tab-pane" role="tabpanel" data-tab={id} hidden={at.hidden} style={at.style}>
                  <MarkdownPreview api={api} worktree={worktree} rel={rel} text={entry.text} />
                </div>,
              ];
            }),
          )}
        {commitOpen && (
          <div className="ws-tab-pane" role="tabpanel" data-tab={COMMIT_TAB} hidden={commitAt.hidden} style={commitAt.style}>
            <CommitView api={api} worktree={worktree} commit={commitOpen} />
          </div>
        )}

        {open && (
          <div className="ws-tab-pane" role="tabpanel" data-tab={REVIEW_TAB} hidden={reviewAt.hidden} style={reviewAt.style}>
            <ReviewView api={api} worktree={worktree} sessions={sessions} reveal={open} />
          </div>
        )}
      </div>

      {tabs.length === 0 && !open && !commitOpen && files.length === 0 && (
        <div className="ws-center-empty">
          <p>{t("workspace.tabs.empty")}</p>
          <div className="ws-launch">
            {[...(defaultShell !== null ? [defaultShell] : []), ...agents].map((p) => (
              <button key={p} type="button" className="btn-secondary" onClick={() => launchGated(p)}>
                {profileName(view, p, t)}
              </button>
            ))}
          </div>
        </div>
      )}
      {dialog}
      {termMenu && byId.get(termMenu.id) && (
        <ContextMenu at={termMenu.at} items={termMenuItems(byId.get(termMenu.id)!, termMenu.handle)} onClose={() => setTermMenu(null)} />
      )}
      {handingOff && byId.get(handingOff.id) && props.worktrees && (
        <HandOffDialog
          profiles={agents.map((id) => ({ value: id, label: profileName(view, id, t) }))}
          worktrees={props.worktrees.map((w) => ({ value: w.path, label: w.label }))}
          sourceProfile={byId.get(handingOff.id)!.profileId}
          sourceWorktree={worktree}
          onConfirm={(choice) => {
            void handOff(byId.get(handingOff.id)!, handingOff.lines, choice);
            setHandingOff(null);
          }}
          onCancel={() => setHandingOff(null)}
        />
      )}
      {titling && byId.get(titling) && (
        <TabTitleDialog
          title={byId.get(titling)!.title ?? profileName(view, byId.get(titling)!.profileId, t)}
          onSave={(title) => {
            sessions.setTitle(titling, title);
            setTitling(null);
          }}
          onCancel={() => setTitling(null)}
        />
      )}
      {unsaved !== null && (
        <UnsavedDialog
          name={fileName(unsaved)}
          onCancel={() => setUnsaved(null)}
          onDiscard={() => {
            fileTabs.close(worktree, unsaved);
            setUnsaved(null);
          }}
          onSave={() => {
            const rel = unsaved;
            setUnsaved(null);
            // Closes once the write went through; a conflict or a failure keeps the tab open.
            void saveFile(io, worktree, rel).then((r) => r === "saved" && fileTabs.close(worktree, rel));
          }}
        />
      )}
      {closing && (
        <CloseTabsDialog
          reason={closing.reason}
          onConfirm={() => {
            closing.run();
            setClosing(null);
          }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  );
}
