import { Button, EmptyState, FileIcon, Icon, IconButton } from "@xdev-asia/ui";
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
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
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
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import {
  addTab,
  equalize,
  focusPane,
  leaves,
  pinFirst,
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
import { TabStrip, type MenuGroup, type StripItem, type TabDrag } from "./TabStrip";
import { AgentIcon } from "./AgentIcon";
import { AgentPicker } from "./AgentPicker";
import { cycleTab, mruOrder, nthTab } from "./tabNav";
import { chosenTab, startSwitch, stepSwitch, type Switch } from "./recentTabs";
import { RecentTabSwitcher, type SwitcherItem } from "./RecentTabSwitcher";
import { closeAllTargets, cycleSameKind, fileCloseTargets, type FileCloseKind, type FileTabInfo, type MoveDir, moveEdge } from "./tabMenu";
import { openFile } from "@/files/openFile";
import { absolutePath, relativePath } from "@/search/resultCopy";
import { TabTitleDialog } from "./TabTitleDialog";
import { toTabStatus } from "@/terminal/programStatus";
import { titleStatus } from "./titles";
import { PtydBanner } from "@/terminal/PtydBanner";
import { WorkerStrip } from "./WorkerStrip";

// Offered while the profile view has not loaded: the built-in agents and the default shell.
const FALLBACK_AGENTS: readonly PtyProfile[] = ["claude", "codex"];
/** How many agents the `+` menu lists before the picker. */
const MENU_AGENTS = 5;
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

/** How long the side preview waits after the last keystroke before it renders the live text. */
export const PREVIEW_DEBOUNCE_MS = 200;

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
  /** The menu's "Terminal link settings" row opens Settings at the link rows. */
  onLinkSettings?: () => void;
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
  /** Opens Settings → Agents (the agent picker's "Manage agents"). */
  onManageAgents?(): void;
}): JSX.Element {
  const { api, sessions, worktree, visible, reveal } = props;
  const { t } = useI18n();
  const navigation = useNavigationSettings();
  // A Ctrl+Tab walk in progress (the switcher is open): the frozen MRU list and the highlight in it. The holder
  // is read between renders; the state draws it.
  const [walking] = useState(() => ({ current: null as Switch | null }));
  const [switcher, setSwitcher] = useState<Switch | null>(null);
  // The pane whose `+` menu is open.
  const [menuPane, setMenuPane] = useState<string | null>(null);
  const [drag, setDrag] = useState<TabDrag | null>(null);
  // The pane whose agent picker is open.
  const [pickerPane, setPickerPane] = useState<string | null>(null);
  // A close that waits for a yes: what it asks about, and what to do on confirm; null when nothing waits.
  const [closing, setClosing] = useState<{ reason: CloseReason; run: () => void } | null>(null);
  // The tab whose title dialog is open, and the terminal menu (tab, pointer, that terminal's handle).
  const [titling, setTitling] = useState<string | null>(null);
  // The hand off dialog: the source tab and its terminal text, read when the menu item was picked.
  const [handingOff, setHandingOff] = useState<{ id: string; lines: string[] } | null>(null);
  const [termMenu, setTermMenu] = useState<{ id: string; at: { x: number; y: number }; handle: TerminalHandle } | null>(null);
  // The action menu of a terminal link (a plain click on a path or a URL).
  const [linkMenu, setLinkMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[]; title: string } | null>(null);
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
  // The focus order for MRU; a walk records only where it ends, not the tabs it passed.
  useEffect(() => {
    if (shown && !walking.current) sessions.noteFocused(worktree, shown);
  }, [shown, sessions, worktree]);
  // A worktree that goes off screen drops its open switcher: nobody is left to see Ctrl released.
  useEffect(() => {
    if (!visible && walking.current) {
      walking.current = null;
      setSwitcher(null);
    }
  }, [visible]);
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

  const { view, update: updateProfiles } = useProfiles();
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
    // The menu keeps the first few; the picker reaches the rest.
    { label: t("workspace.tabs.agents"), ids: agents.slice(0, MENU_AGENTS), picker: view !== null },
    { label: t("workspace.tabs.shells"), ids: shells },
  ].filter((g) => g.ids.length > 0 || g.picker === true);
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
    setPickerPane(null);
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
  function splitTab(pane: string, id: string, dir: MoveDir): void {
    const leaf = panes.find((n) => n.id === pane);
    if (!layout || !leaf || leaf.tabs.length < 2) return;
    const without = removeTab(layout, id);
    if (without) setLayout(splitPane(without, pane, dir === "left" || dir === "right" ? "right" : "down", id, dir === "left" || dir === "up"));
  }

  // The tab menu's Move to Split: a terminal goes through the sessions store, the other tabs through the tree.
  function moveTab(pane: string, id: string, dir: MoveDir): void {
    if (id === REVIEW_TAB || isFileTab(id) || isPreviewTab(id)) return splitTab(pane, id, dir);
    if (dir === "right" || dir === "down") return sessions.moveToSplit(id, dir);
    sessions.dropToSplit(worktree, id, pane, moveEdge(dir));
  }

  // The file tab whose Save / Don't Save / Cancel dialog is open.
  // Several when a bulk close meets unsaved files: the dialog asks about the first, then the next.
  const [unsaved, setUnsaved] = useState<string[]>([]);
  const io = { api, store: fileTabs, t };

  // Saved files close now (and can be reopened); files with unsaved edits wait for the dialog.
  function closeFiles(rels: string[]): void {
    const dirty: string[] = [];
    for (const rel of rels) {
      const entry = fileTabs.get(worktree, rel);
      if (entry && isDirty(entry)) dirty.push(rel);
      else fileTabs.closeRemembering(worktree, rel);
    }
    if (dirty.length > 0) setUnsaved(dirty);
  }

  // The open file tabs among `ids`, with their dirty and pinned marks.
  function fileInfos(ids: readonly string[]): FileTabInfo[] {
    return ids.flatMap((id) => {
      const rel = fileTabRel(id);
      const entry = rel === null ? undefined : fileTabs.get(worktree, rel);
      return rel !== null && entry ? [{ rel, dirty: isDirty(entry), pinned: !!entry.pinned }] : [];
    });
  }

  function closeAllFiles(): boolean {
    const targets = fileCloseTargets(fileInfos(files.map((f) => fileTabId(f.rel))), null, "all");
    if (targets.length === 0) return false;
    closeFiles(targets);
    return true;
  }

  // Mod+Shift+T: the newest closed tab, a file or a terminal, whichever closed last.
  function reopenClosed(): boolean {
    const fileAt = fileTabs.lastClosedAt(worktree);
    const termAt = sessions.lastClosedAt(worktree);
    if (fileAt !== null && (termAt === null || fileAt >= termAt)) {
      const closed = fileTabs.takeClosed(worktree);
      if (closed) {
        openFile({ worktree, rel: closed.rel });
        if (closed.pinned) fileTabs.setPinned(worktree, closed.rel, true);
        return true;
      }
    }
    return sessions.reopenClosed(worktree) !== null;
  }

  function pinFile(rel: string, pinned: boolean): void {
    fileTabs.setPinned(worktree, rel, pinned);
    const now = sessions.layout(worktree);
    const pane = now && paneOf(now, fileTabId(rel));
    if (!now || !pane) return;
    const isPinned = (id: string) => {
      const r = fileTabRel(id);
      return r !== null ? !!fileTabs.get(worktree, r)?.pinned : (byId.get(id)?.pinned ?? false);
    };
    setLayout(pinFirst(now, pane, isPinned));
  }

  // The next / previous tab of the front tab's kind: files with files, terminals with terminals.
  function stepSameKind(step: 1 | -1): boolean {
    const kindOf = (id: string) =>
      isFileTab(id) ? "file" : isPreviewTab(id) ? "preview" : id === REVIEW_TAB || id === COMMIT_TAB ? id : "terminal";
    const to = cycleSameKind(focusedLeaf?.tabs ?? [], shown, step, kindOf);
    if (to === null) return false;
    go(to);
    return true;
  }

  // Close all: every terminal, agent and file tab of the worktree that is not pinned. Unsaved files ask in the
  // Save / Don't save dialog; a running agent asks as a single close does.
  function closeAllTabs(): boolean {
    const kindOf = (id: string): "terminal" | "file" | "other" =>
      isFileTab(id) ? "file" : isPreviewTab(id) || id === REVIEW_TAB || id === COMMIT_TAB ? "other" : "terminal";
    const pinnedOf = (id: string) => {
      const rel = fileTabRel(id);
      return rel !== null ? !!fileTabs.get(worktree, rel)?.pinned : !!byId.get(id)?.pinned;
    };
    const targets = closeAllTargets(panes.flatMap((n) => n.tabs).map((id) => ({ id, kind: kindOf(id), pinned: pinnedOf(id) })));
    if (targets.length === 0) return false;
    const rels = targets.flatMap((id) => fileTabRel(id) ?? []);
    if (rels.length > 0) closeFiles(rels);
    requestClose(targets.filter((id) => fileTabRel(id) === null));
    return true;
  }

  function closeTab(id: string): void {
    const rel = fileTabRel(id);
    if (rel !== null) return closeFiles([rel]);
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

  // Ctrl+Tab in MRU order opens the switcher over every tab of the worktree; Tab goes on down the list.
  function stepSwitcher(step: 1 | -1): boolean {
    const held = walking.current;
    const next =
      held ?
        stepSwitch(held, step)
      : startSwitch(
          mruOrder(panes.flatMap((n) => n.tabs), sessions.recentTabs(worktree)),
          shown,
          step,
        );
    if (next === null) return false;
    walking.current = next;
    setSwitcher(next);
    return true;
  }

  // Ctrl released: the highlighted tab comes to the front (and is recorded as the newest); Esc leaves things as they were.
  function endSwitch(activate: boolean): void {
    const held = walking.current;
    if (!held) return;
    walking.current = null;
    setSwitcher(null);
    const to = chosenTab(held);
    if (activate && panes.some((n) => n.tabs.includes(to))) go(to);
  }

  function switcherItems(list: readonly string[]): SwitcherItem[] {
    return list.map((id): SwitcherItem => {
      if (id === REVIEW_TAB) return { id, title: t("review.tab"), icon: <Icon name="diff" /> };
      if (id === COMMIT_TAB) return { id, title: t("commitView.tab", { id: (commitOpen?.id ?? "").slice(0, 7) }), icon: <Icon name="diff" /> };
      const previewRel = previewTabRel(id);
      if (previewRel !== null) return { id, title: t("files.preview.tab", { name: fileName(previewRel) }), icon: <Icon name="eye" />, path: previewRel };
      const rel = fileTabRel(id);
      if (rel !== null) return { id, title: fileName(rel), icon: <FileIcon name={fileName(rel)} />, path: rel };
      const tab = byId.get(id);
      return tab
        ? { id, title: tab.title ?? profileName(view, tab.profileId, t), icon: <AgentIcon profile={tab.profileId} size={16} /> }
        : { id, title: id, icon: <Icon name="terminal" /> };
    });
  }

  // `e` tells the chord: Ctrl+Tab (in MRU order) opens the switcher, any other chord of next / previous tab walks the strip.
  function stepTab(step: 1 | -1, e?: KeyboardEvent): boolean {
    if (navigation.tabOrder === "mru" && e?.ctrlKey && e.code === "Tab") return stepSwitcher(step);
    const to = cycleTab(focusedLeaf?.tabs ?? [], shown, step);
    if (to === null || to === shown) return false;
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
  // What `auto` or the saved default resolves to; null starts the default shell.
  const defaultAgent: PtyProfile | null = view ? view.resolvedDefault : FALLBACK_AGENTS[0];
  function launchDefault(pane?: string): void {
    setPickerPane(null);
    const profile = defaultAgent ?? defaultShell;
    if (profile !== null) launchGated(profile, pane);
  }
  // The first press opens the picker in the focused pane; a press while it is open starts the default.
  function agentNew(): void {
    if (pickerPane !== null) return launchDefault(pickerPane);
    if (!view || !layout) return launchDefault();
    setMenuPane(null);
    setPickerPane(layout.focused);
  }
  useKeymap(
    {
      "agent.new": () => agentNew(),
      "tab.new": () => newShell(),
      "tab.reopenClosed": () => reopenClosed(),
      "tab.nextSameKind": () => stepSameKind(1),
      "tab.prevSameKind": () => stepSameKind(-1),
      "tab.closeAll": () => closeAllTabs(),
      "file.closeAll": () => closeAllFiles(),
      "tab.close": () => requestClose(shown ? [shown] : []),
      "tab.next": (e) => stepTab(1, e),
      "tab.prev": (e) => stepTab(-1, e),
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
      tab.extraArgs ?? undefined,
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
        if (!entry) return [];
        const gone = entry.external === "deleted" || entry.external === "renamed" ? entry.external : undefined;
        const file = { rel, dirty: isDirty(entry), ...(entry.pinned ? { pinned: true } : {}), ...(markdownFile(rel) ? { markdown: true } : {}), ...(gone ? { gone } : {}) };
        return [{ id, tab: null, file }];
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
        onCloseAll={closeAllTabs}
        onLaunch={(profile) => launchGated(profile, leaf.id)}
        onAgentPicker={() => {
          setMenuPane(null);
          setPickerPane(leaf.id);
        }}
        agentPicker={
          pickerPane === leaf.id && view ? (
            <AgentPicker
              api={api}
              view={view}
              onPick={(id) => {
                setPickerPane(null);
                const profile = id ?? defaultShell;
                if (profile !== null) launchGated(profile, leaf.id);
              }}
              onClose={() => setPickerPane(null)}
              onManage={() => props.onManageAgents?.()}
              onView={updateProfiles}
            />
          ) : null
        }
        onSplit={(dir) => defaultShell !== null && splitWith(leaf.id, dir, defaultShell)}
        onMoveToSplit={(id, dir) => moveTab(leaf.id, id, dir)}
        onReorder={(id, before) => sessions.reorderTab(id, before)}
        onDragTab={setDrag}
        onDropZone={(id, pane, zone) => sessions.dropToSplit(worktree, id, pane, zone)}
        onPin={(id, pinned) => {
          const rel = fileTabRel(id);
          if (rel !== null) pinFile(rel, pinned);
          else sessions.setPinned(id, pinned);
        }}
        onCloseFiles={(id, kind: FileCloseKind) => closeFiles(fileCloseTargets(fileInfos(leaf.tabs), fileTabRel(id), kind))}
        onCopyFilePath={(rel, relative) => void copyText(relative ? relativePath(rel) : absolutePath(worktree, rel))}
        onOpenPreview={(rel) => void openPreview(rel, { pane: leaf.id })}
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
            tabDrag={drag}
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
              {!tab.asleep && (everFront.has(tab.id) || !sessions.deferred(tab.id)) && <SurfaceBoundary id={`terminal.${tab.id}`} surface="Terminal" resetKey={attempts[tab.id] ?? 0}><Terminal
                key={`${tab.id}:${attempts[tab.id] ?? 0}`}
                api={api}
                client={tab.client}
                id={tab.id}
                cwd={worktree}
                worktree={worktree}
                onLinkMenu={(at, items, title) => setLinkMenu({ at, items, title })}
                onLinkSettings={props.onLinkSettings}
                profile={tab.profileId}
                account={ownAccount(tab)}
                onStarted={(info) => sessions.noteStarted(tab.id, info)}
                onError={(e) => failed(tab, e)}
                onOutput={(bytes) => sessions.noteOutput(tab.id, bytes)}
                onInput={(text) => sessions.noteInput(tab.id, text)}
                onBell={() => sessions.noteBell(tab.id)}
                onProgramStatus={(r) => {
                  const status = toTabStatus(r.state, r.kind);
                  if (status) sessions.noteProgramStatus(tab.id, status, r.progress, r.msg);
                }}
                onProgress={(p) => sessions.noteProgress(tab.id, p)}
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
              /></SurfaceBoundary>}
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
              <SurfaceBoundary id="editor.file" surface="Editor" resetKey={file.rel}><FileView api={api} worktree={worktree} rel={file.rel} /></SurfaceBoundary>
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
                  <MarkdownPreview api={api} worktree={worktree} rel={rel} text={entry.text} debounceMs={PREVIEW_DEBOUNCE_MS} hidden={at.hidden} />
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
            <SurfaceBoundary id="review" surface="Review" resetKey={worktree}><ReviewView api={api} worktree={worktree} sessions={sessions} reveal={open} /></SurfaceBoundary>
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
      {visible && switcher && (
        <RecentTabSwitcher
          items={switcherItems(switcher.list)}
          at={switcher.at}
          steps={switcher.steps}
          onCommit={() => endSwitch(true)}
          onCancel={() => endSwitch(false)}
        />
      )}
      {termMenu && byId.get(termMenu.id) && (
        <ContextMenu at={termMenu.at} items={termMenuItems(byId.get(termMenu.id)!, termMenu.handle)} onClose={() => setTermMenu(null)} />
      )}
      {linkMenu && <ContextMenu at={linkMenu.at} items={linkMenu.items} title={linkMenu.title} onClose={() => setLinkMenu(null)} />}
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
      {unsaved.length > 0 && (
        <UnsavedDialog
          name={fileName(unsaved[0])}
          onCancel={() => setUnsaved([])}
          onDiscard={() => {
            const rel = unsaved[0];
            fileTabs.closeRemembering(worktree, rel);
            setUnsaved((q) => q.slice(1));
            // The edits are gone; Reopen reads the file from disk again.
            pushToast({
              text: t("tabMenu.discarded", { name: fileName(rel) }),
              actions: [{ label: t("tabMenu.reopen"), run: () => openFile({ worktree, rel }) }],
            });
          }}
          onSave={() => {
            const rel = unsaved[0];
            setUnsaved((q) => q.slice(1));
            // Closes once the write went through; a conflict or a failure keeps the tab open.
            void saveFile(io, worktree, rel).then((r) => r === "saved" && fileTabs.closeRemembering(worktree, rel));
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
