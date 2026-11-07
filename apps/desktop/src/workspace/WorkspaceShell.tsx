import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import pkg from "../../package.json";
import { BrandMark } from "@/components/BrandMark";
import { ProfilesProvider, SSH_SHELL_PREFIX, profileName } from "@/agents/profileStore";
import { SETUP_PROFILE, toApiError, type Api, type ApiError, type Check, type Created, type Linked, type OpenInApp, type OpenTarget, type HookDetail, type ScriptKind, type RepoHooks, type PrView, type PtyProfile, type DetailsPatch, type KeptBranch, type RepoGroup, type FolderEntry, type WorkStatus, type SidebarItem, type SidebarPrefs, type RepoView, type WorktreeChange, type WorktreeView, type Issue, type IssueDetail, type CreateRequest, type PrSummary, type MrSummary, type MenuAction, type SetupDecision, type BaseDrift, type Provider, type ProfilesView } from "@/api";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { docsStatusItems } from "./docsStatusItems";
import { DocsHost, type DocsHostStatus } from "@/docs/DocsHost";
import type { DocsHandle } from "@/docs/types";
import { PlaceStage } from "./PlaceStage";
import { useI18n } from "@/i18n";
import { onTryFeature } from "@/featureWall/featureWallStore";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { CrashHost } from "@/crash/CrashHost";
import { MissionHost } from "@/orchestration/MissionHost";
import { ChartsHost } from "@/orchestration/charts/ChartsHost";
import { ResourceHost } from "@/stats/ResourceHost";
import { MergeDialog, type MergeSource } from "./MergeDialog";
import { StartupBanner } from "@/startup/StartupBanner";
import { onTabJump } from "./tabJump";
import { PaletteHost } from "@/palette/PaletteHost";
import { NavButtons } from "@/nav/NavButtons";
import { useNavHistory } from "@/nav/useNavHistory";
import { useKeymap, type ActionId } from "@/keys/keymap";
import { setTerminalKeyHost, startDiagnosticToasts } from "@/keys/terminalKey";
import { startOptionAsAltProbe } from "@/terminal/optionAsAlt";
import { startAutosave } from "@/files/autosave";
import { useWorktreeWatch } from "./useWorktreeWatch";
import { ComposerHost, type ComposerRequest } from "@/composer/ComposerHost";
import { FloatingHost } from "@/floating/FloatingHost";
import { withFloatingSave } from "@/floating/floatingPersist";
import { DictationHost } from "@/dictation/DictationHost";
import { FloatingItem } from "@/floating/FloatingItem";
import { repoOf, TaskEditorHost } from "@/tasks/board/TaskEditorHost";
import { fileTabId, fileTabRel, fileTabs } from "@/files/fileTabs";
import { onOpenFile, openFile as requestOpenFile, type OpenFileRequest } from "@/files/openFile";
import { LayoutControls } from "./LayoutControls";
import { paneOf, splitPane } from "./paneTree";
import { QuickOpenDialog } from "@/search/QuickOpenDialog";
import { recentFiles } from "@/search/recentFiles";
import { SearchPanel } from "@/search/SearchPanel";
import { Toasts } from "./Toasts";
import { pushToast } from "./toastStore";
import { baseBehindToast } from "./baseBehind";
import { addFoldersNotice, addRepoFolders } from "./addFolders";
import { livePortsByWorktree, stopFromCard } from "./livePorts";
import type { LivePort } from "./livePorts";
import { endpoint } from "./PortsChip";
import { startAutoRename } from "./autoRename";
import { startAutoTabTitle } from "./autoTabTitle";
import { startAutoSleep } from "./autoSleep";
import { startKeepAwakeReport } from "@/status/keepAwake";
import { flash } from "./flash";
import { startBusyReport } from "@/stats/busyReport";
import { startNotchReport } from "@/notch/notchReport";
import { ReviewPanel } from "./ReviewPanel";
import { onPrPageOpen, onPrPanelOpen } from "./prPanelEvents";
import { ForeignTermsHost } from "@/foreignTerms/ForeignTermsHost";
import { currentCloseWindow, openRestoredFile, restoreLayout, sessionFallback, startLayoutSave, undoRestore } from "./layoutPersist";
import { copyText } from "@/terminal/terminalActions";
import { loadZoom, stepZoom, ZOOM_STEP } from "@/ui/zoom";
import { useJumpKey } from "@/palette/useJumpKey";
import { getNavigationSettings, setNavigationSettings, useNavigationSettings } from "@/settings/navigationSettings";
import { SettingsView } from "@/settings/SettingsView";
import { playStatusSound } from "@/status/sound";
import { usePresence } from "@/status/presence";
import { getStatusSettings, loadStatusSettings, useStatusSettings } from "@/status/statusSettings";
import { admits } from "./attention";
import { ActivityPanel, type ActivityTab } from "@/activity/ActivityPanel";
import { ActivityFeed } from "@/activity/feed";
import { AttentionInbox, Button, Icon } from "@xdev-asia/ui";
import { BellMenu, bellCount, type BellRow } from "./BellMenu";
import { ChecksPanel } from "./ChecksPanel";
import { PortsItem } from "@/ports/PortsItem";
import { PortsPanel } from "@/ports/PortsPanel";
import { PortsStore } from "@/ports/portsStore";
import { IssuesPanel } from "@/issues/IssuesPanel";
import { issuesTabVisible } from "@/issues/issuesPreset";
import { CreateWorktreeDialog, type AgentChoice, type CreateExtra, type CreateTab } from "./CreateWorktreeDialog";
import { DetailsDialog } from "./DetailsDialog";
import { CheckoutBranchDialog } from "./CheckoutBranchDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { PendingCreates, type CreateArgs } from "./pendingCreates";
import { FileTree } from "./FileTree";
import { HeaderSearch } from "./HeaderSearch";
import { Titlebar } from "./Titlebar";
import { ShellFrame } from "@/shell/ShellFrame";
import { railPlaces } from "@/shell/places";
import { useAppOrder, useHiddenApps } from "@/ui/hiddenApps";
import { NarrowNav, type NarrowPlace } from "@/shell/NarrowNav";
import { RemoteBanner } from "@/remote/RemoteBanner";
import { RemoteGroup } from "@/remote/RemoteGroup";
import { projectOf, reconnectCandidate, remoteError, remoteRepo, remoteRows } from "@/remote/model";
import { useRemoteProjects } from "@/remote/useRemoteProjects";
import { AddProjectDialog, parentOf } from "./AddProjectDialog";
import { RemoveRepoDialog } from "./RemoveRepoDialog";
import { ParentPickerDialog } from "./ParentPickerDialog";
import { parentCandidates } from "./lineage";
import { keptOutcome, removeArgs } from "./deleteFlow";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { removeRepo } from "./removeRepo";
import { VaultNav } from "./VaultNav";
import type { AppId } from "@/shell/apps";
import { LiveWorkspaceFooter } from "./WorkspaceFooter";
import { sendCheckFix, sendChecksFix, sendCommentsFix, sendFix } from "./fixAgent";
import type { CommentGroup } from "./prComments";
import type { SendOutcome } from "./PrSendBar";
import { sendToAgentTab, sendToOpenedTab, type SendChoice } from "./agentPrompt";
import { issuePrompt, issueWorkItem, issueWorktreeName, uniqueWorktreeName } from "@/issues/issueStart";
import { mrWorkItem, mrWorktreeName, prWorkItem, prWorktreeName } from "./createSource";
import { effectiveIssueCommand, issueTemplateVars, renderIssueCommand } from "@/issues/issueTemplate";
import { sendTarget } from "./sendTarget";
import { SetupCard, type SetupCardState } from "./SetupCard";
import { openDefaultTabs } from "./defaultTabs";
import { failedLinks } from "./linkReport";
import { decideSetup, hasPending, pendingLists, type PendingLists } from "./setupFlow";
import { SetupGate } from "./setupGate";
import { ShellOverlays } from "./ShellOverlays";
import { ShellSidebar } from "./ShellSidebar";
import { WorkspaceStage } from "./WorkspaceStage";
import { startCliReport } from "./cliReport";
import { startCliEvents } from "./cliEvents";
import { startCliTerminal } from "./cliTerminal";
import { openFailedToast, startOrchestrationEvents } from "./orchestrationEvents";
import { AutomationsPage } from "@/automations/AutomationsPage";
import { startAutomationDispatch } from "@/automations/dispatch";
import { useAutomationsSettings } from "@/settings/automationsSettings";
import { terminalOf } from "@/terminal/terminalRegistry";
import { TrustDialog } from "./TrustDialog";
import { AccountSwitchDialog, type SwitchScope, type SwitchTab } from "./AccountSwitchDialog";
import { restartTabs } from "./accountSwitchFlow";
import { watchQuotaAlerts } from "./quotaAlerts";
import { watchFailovers } from "./failoverToasts";
import { QuitDialog } from "./QuitDialog";
import { UpsellHost } from "@/license/Upsell";
import { AboutDialog } from "./AboutDialog";
import { checkForUpdates, HelpButton, type HelpPick, runHelpPick } from "./HelpMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SshAuthPrompts } from "@/components/SshAuthDialog";
import { PeersHost } from "@/peers/PeersHost";
import { runMenuAction } from "@/shell/menuActions";
import { useShellLabels } from "@/shell/shellLabels";
import { useShellAccountSwitch } from "@/shell/useShellAccountSwitch";
import { useShellCardPorts } from "@/shell/useShellCardPorts";
import { useShellLayoutRestore } from "@/shell/useShellLayoutRestore";
import { useShellNotifications } from "@/shell/useShellNotifications";
import { useNeedsYou } from "@/shell/useNeedsYou";
import { agentOf, needsDot } from "./needsYou";
import { ago } from "./ago";
import { useShellAgentFix } from "@/shell/useShellAgentFix";
import { useShellCreate } from "@/shell/useShellCreate";
import { useShellDialogs } from "@/shell/useShellDialogs";
import { useShellRemoteActions } from "@/shell/useShellRemoteActions";
import { useShellRemove } from "@/shell/useShellRemove";
import { useShellRepoActions } from "@/shell/useShellRepoActions";
import { useShellSetup } from "@/shell/useShellSetup";
import { useShellServices } from "@/shell/useShellServices";
import { useShellPanels } from "@/shell/useShellPanels";
import { useShellViews } from "@/shell/useShellViews";
import { annotateClipboard } from "@/capture/annotateBridge";
import { CaptureHost } from "@/capture/CaptureHost";
import { startCapture, useCaptureFailures } from "@/capture/useCaptureFailures";
import { askQuit, guardClose, installCloseGuard, type QuitAsk, type QuitChoice } from "./quitGuard";
import { getTerminalSettings } from "@/terminal/terminalSettings";
import { eventInTerminal, FONT_STEP, stepTerminalFont } from "@/terminal/terminalZoom";
import { createNotifier, type Notifier } from "./notifier";
import { AgentSessionsStore } from "@/agentSessions/store";
import { confirmResume } from "@/agentSessions/resumeFlow";
import { SessionsSidebar } from "@/agentSessions/SessionsSidebar";
import { Sessions, type Attention, type Tab } from "./sessions";
import { PrCommentStore } from "./prCommentStore";
import { PrStore } from "./prs";
import { WorktreeStats } from "./stats";
import type { TabStatus } from "./status";
import { WorktreeChanges } from "./WorktreeChanges";
import { worktreeTarget } from "./groups";
import { WorktreeList } from "./WorktreeList";
import { NameDialog } from "./NameDialog";
import { flattenRepos, keptByRepo } from "./sidebarModel";
import { bulkSleepable, clear as clearPicked, click as pickClick, runBulk, selectAll, type BulkResult, type Selection } from "./selection";
import { BulkBar } from "./BulkBar";
import { BulkRemoveDialog } from "./BulkRemoveDialog";
import { ReviewBranchesDialog } from "./ReviewBranchesDialog";
import { KanbanBoard } from "./KanbanBoard";
import { isDeleteKey, typingIn } from "./deleteKey";
import type { CommitAsk } from "./CommitView";
import { IS_MAC, PLATFORM } from "@/platform";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startFileDrop, type DropEvent } from "@/terminal/fileDrop";
import { WorktreeTabs, type Reveal } from "./WorktreeTabs";
import { RightPanel } from "@/panel/RightPanel";
import {
  AUTO_SLEEP_TICK_MS, NO_CHANGES, readSelected, storeSelected, windowFocused, working, worktreeName,
  type BulkState, type Creating, type Editing, type PanelTab, type Removing, type Review, type SetupCardAt, type TrustAsk, type View,
} from "./shellModel";
import { runWithToast } from "@/quickCommands/runUi";
import { startQuickCommands } from "@/quickCommands/store";


/** The app frame: repos and worktrees on the left, the selected worktree in the middle. */
// Below the shell's collapse width the side list is a drawer.
function isNarrow(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767.98px)").matches;
}

export function WorkspaceShell(props: { api: Api }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const { askBeforeDeleteWorktree, alwaysForceDeleteWorktrees, alwaysDeleteKeptBranches } = useNavigationSettings();
  const [localRepos, setRepos] = useState<RepoView[] | null>(null);
  // Remote projects list as repos too, so selection, tabs and the file tree treat their `ssh://` worktree like any other.
  const remote = useRemoteProjects(api);
  const repos = useMemo(() => (localRepos === null ? null : [...localRepos, ...remote.projects.map(remoteRepo)]), [localRepos, remote.projects]);
  const remoteKept = useRef<string[]>([]);
  remoteKept.current = remote.projects.map((p) => p.worktree);
  const [items, setItems] = useState<SidebarItem[] | null>(null);
  const [prefs, setPrefs] = useState<SidebarPrefs>(SIDEBAR_PREFS_DEFAULTS);
  // The multi-selection, the bulk delete or archive dialog, and the branch review.
  const [picked, setPicked] = useState<Selection>(clearPicked);
  const [selected, setSelected] = useState<string | null>(() => readSelected());
  const views = useShellViews();
  const { view, show, mounted: placesMounted, tasksRequest, docsRequest, openDocsSection, docsKey, setDocsKey, settingsAt, setSettingsAt, openSettings, openUsage, openTask, openTaskBoard, openDecompose, openAccounts, openSearch } = views;
  // Agent and shell names for the merge headings and the resource manager rows.
  const [nameView, setNameView] = useState<ProfilesView | null>(null);
  const dialogs = useShellDialogs(api);
  const {
    composerAsk, setComposerAsk, mergeSources, setMergeSources, about, setAbout, machine, boardOpen, setBoardOpen, confirmEndAll, setConfirmEndAll,
    renaming, setRenaming, checkingOut, setCheckingOut, parentFor, setParentFor, jumpOpen, setJumpOpen, quickOpen, setQuickOpen, openAbout,
  } = dialogs;
  // The tab in front of each worktree, which is where a prompt from the Agent kit is typed.
  const [shownTab, setShownTab] = useState<Record<string, string | null>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  // Docs draws its side list into this slot of the sidebar and tells the shell its status.
  const [navSlot, setNavSlot] = useState<HTMLElement | null>(null);
  const [docsStatus, setDocsStatus] = useState<DocsHostStatus | null>(null);
  const docsRef = useRef<DocsHandle | null>(null);
  // The right panel (Files / Changes / Checks); hidden, not unmounted, so its state stays.
  const [sessions, setSessions] = useState<Sessions | null>(null);
  // The agent session history, and which of the two sidebar views shows.
  const [history, setHistory] = useState<AgentSessionsStore | null>(null);
  const [sideView, setSideView] = useState<"worktrees" | "sessions" | "activity">("worktrees");
  const [feed] = useState(() => new ActivityFeed());
  const [activityAsk, setActivityAsk] = useState<{ tab: ActivityTab; seq: number }>({ tab: "threads", seq: 0 });
  // A new `seq` asks the sessions panel for the search box, or to mark one session.
  const [sessionsAsk, setSessionsAsk] = useState<{ seq: number; focus: boolean; reveal: { key: string; seq: number } | null }>({ seq: 0, focus: false, reveal: null });
  const [gate] = useState(() => new SetupGate());
  const [notice, setNotice] = useState<ApiError["code"]>();
  // A request to bring a tab to the front of its worktree; a new `seq` is a new request.
  const [front, setFront] = useState<{ worktree: string; id: string; seq: number } | null>(null);
  // Worktrees shown so far; their tabs stay mounted, hidden, so a switch never stops a pty.
  const [visited, setVisited] = useState<string[]>([]);
  // The file a diff tab should show, for the worktree that asked.
  const [reveal, setReveal] = useState<(Reveal & { worktree: string }) | null>(null);
  // The commit the commit tab shows, and the worktree it belongs to.
  const [commitAsk, setCommitAsk] = useState<(CommitAsk & { worktree: string }) | null>(null);
  // The terminal panes on screen in each worktree, as its tab strip reports them.
  const [panes, setPanes] = useState<Record<string, string[]>>({});
  const statusSettings = useStatusSettings();
  const automationsSettings = useAutomationsSettings();
  // What the long-lived listeners read: the latest render's list, words and jump, much like a ref.
  const [live] = useState(() => ({ repos: null as RepoView[] | null, t, jump: (_id: string): boolean => false, openShortcuts: (_action?: string) => {}, openFileTab: (_req: OpenFileRequest) => {}, openDiff: (_w: string, _f: string, _b: string | null) => {}, openPrTab: () => {}, openPrPage: () => {}, deleteKey: () => {}, notifier: null as Notifier | null, selected: null as string | null, reload: () => {}, ensureMounted: (_w: string) => {}, prepareSetup: async (_w: string) => {}, cliOpen: (_w: string, _p: string, _prompt: string | null, _o?: { id?: string; account?: string }) => {}, cliPoke: () => {}, automationSetup: async (_w: string, _r: string, _d: SetupDecision) => {} }));

  // The line counts of the listed worktrees. The object holds nothing live until the effect
  // below attaches it, so load() can hand it the list before or after that.
  const [stats] = useState(() => new WorktreeStats());
  // Pull requests and checks of every worktree, shared by the ship bar and the panels.
  const [prs] = useState(() => new PrStore(api));
  const [prComments] = useState(() => new PrCommentStore(api));
  // The listening ports of every worktree; it polls only while the Ports tab is in front.
  const [ports] = useState(() => new PortsStore(api));
  // Asks the front terminal of a worktree to take keyboard focus, as the palette closes.
  const [termFocus, setTermFocus] = useState<{ worktree: string; seq: number } | null>(null);
  const focusTerminal = (worktree: string) => setTermFocus((f) => ({ worktree, seq: (f?.seq ?? 0) + 1 }));
  const [openInApps, setOpenInApps] = useState<OpenInApp[]>([]);
  // A new value asks the front pane to open its quick commands popover.
  const [quickSeq, setQuickSeq] = useState(0);
  // The worktrees in the order the sidebar draws them, which the worktree keys walk.
  const [order, setOrder] = useState<string[]>([]);

  // One store of terminal tabs for the whole shell. Made in an effect so a dev double mount
  // disposes the first one; disposing kills its ptys.
  useEffect(() => {
    // A pane in view stays quiet unless the person turned that off in Settings; read again on each event.
    const store = new Sessions(api, () => Date.now(), () => getStatusSettings().suppressWhenFocused);
    setSessions(store);
    const history = new AgentSessionsStore(api, store);
    setHistory(history);
    const offGate = gate.attach(store);
    stats.attach(api, store, typeof window === "undefined" ? undefined : window);
    return () => {
      offGate();
      stats.detach();
      history.dispose();
      store.dispose();
    };
  }, [api]);

  async function load(): Promise<RepoView[] | null> {
    try {
      const tree = await api.workspaceSidebar();
      const list = flattenRepos(tree);
      setItems(tree);
      setRepos(list);
      stats.track(list.flatMap((r) => r.worktrees.map((w) => w.path)));
      // A worktree gone from the list (removed outside the app, say) must not keep its ptys. A
      // missing repo lists no worktrees though they may still exist, so nothing closes then.
      if (!list.some((r) => r.missing)) {
        const kept = new Set([...list.flatMap((r) => r.worktrees.map((w) => w.path)), ...remoteKept.current]);
        for (const path of sessions?.worktrees() ?? []) if (!kept.has(path)) void sessions?.closeWorktree(path);
        // The registry is complete here, so a saved layout of a worktree it does not list is gone for good.
        for (const path of sessions?.carriedWorktrees() ?? []) if (!kept.has(path)) sessions?.dropCarried(path);
      }
      return list;
    } catch (e) {
      setNotice(toApiError(e).code);
      setRepos((r) => r ?? []);
      return null;
    }
  }

  useEffect(() => {
    void load();
    // Loaded once; every action below reloads after it changes the list.
  }, [api]);
  const panels = useShellPanels({ api, view, show, setSidebarOpen, sessions });
  const {
    rightOpen, setRightOpen, changesReady, registerChanges, runOnChanges, panelTab, setPanelTab, issuesGit, issuesPinned,
    searchFocus, focusSearch, prPage, panelKey, openPrTab, openPrPage, changeCount, setChangeCount, changeList, setChangeList,
  } = panels;

  useEffect(() => {
    const mac = IS_MAC;
    const onKey = (e: KeyboardEvent) => {
      if (!isDeleteKey(e, mac) || typingIn(e.target)) return;
      e.preventDefault();
      live.deleteKey();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    api.sidebarPrefsGet().then(setPrefs, () => {});
  }, [api]);

  // A worktree made with an automatic name gets its branch named from the first prompt of its agent.
  // The watcher reads what each render knows through this ref.
  const renameLive = useRef<{ worktrees: WorktreeView[]; t: typeof t; reload(): void }>({ worktrees: [], t, reload() {} });
  renameLive.current = { worktrees: (repos ?? []).flatMap((r) => r.worktrees), t, reload: () => void load() };
  useEffect(() => {
    if (!sessions) return;
    return startAutoRename({
      api,
      sessions,
      worktrees: () => renameLive.current.worktrees,
      t: (key, vars) => renameLive.current.t(key, vars),
      reload: () => renameLive.current.reload(),
      toast: pushToast,
    });
  }, [api, sessions]);

  // Agent tabs take a short title from their first prompt when Settings → Agents asks for it.
  useEffect(() => {
    if (!sessions) return;
    return startAutoTabTitle({ api, sessions });
  }, [api, sessions]);

  // An account crossing a quota threshold raises a toast that can move new tabs to another account.
  useEffect(() => watchQuotaAlerts({ api, t: (key, vars) => live.t(key, vars), toast: pushToast }), [api]);
  useEffect(() => watchFailovers({ api, t: (key, vars) => live.t(key, vars), toast: pushToast }), [api]);

  const layout = useShellLayoutRestore({ api, sessions, repos, t, live });
  const { restored, quitting } = layout;


  const acct = useShellAccountSwitch({
    api, sessions, t, live,
    frontTab: () => (sessions && current ? sendTarget(sessions.tabs(current.path), shownTab[current.path] ?? null) : null),
  });
  const { switching, setSwitching, pickAccount, answerSwitch } = acct;

  const paths = repos?.flatMap((r) => r.worktrees.map((w) => w.path)) ?? [];
  const subscribe = useCallback((listener: () => void) => sessions?.subscribe(listener) ?? (() => {}), [sessions]);
  // The live agent tab in front of a worktree, if any: where the Agent kit types.
  const target = (path: string | undefined) => (sessions && path ? sendTarget(sessions.tabs(path), shownTab[path] ?? null) : null);
  // A string, so an unchanged store reads as the same snapshot.
  const signature = () =>
    sessions
      ? paths.map((p) => `${sessions.dot(p) ?? ""}:${working(sessions, p)}:${sessions.unread(p) ? "u" : ""}:${target(p)?.id ?? ""}`).join("|") +
        `#${sessions.unreadTabs().map((tab) => `${tab.id}:${tab.status}:${tab.unreadAt}`).join(",")}`
      : "";
  useSyncExternalStore(subscribe, signature, signature);
  useSyncExternalStore(useCallback((fn: () => void) => gate.subscribe(fn), [gate]), () => gate.snapshot(), () => gate.snapshot());
  useSyncExternalStore(stats.subscribe, stats.snapshot, stats.snapshot);
  useSyncExternalStore(useCallback((fn: () => void) => prs.subscribe(fn), [prs]), () => prs.snapshot(), () => prs.snapshot());

  // What waits on the person: one selector feeds the header inbox, the dots and the footer count.
  const needs = useNeedsYou(sessions);
  const dots: Record<string, TabStatus | null> = Object.fromEntries(paths.map((p) => [p, needsDot(needs, p) ?? sessions?.dot(p) ?? null]));
  const activity: Record<string, number | null> = Object.fromEntries(paths.map((p) => [p, sessions?.lastActivity(p) ?? null]));
  const profiles: Record<string, PtyProfile[]> = Object.fromEntries(paths.map((p) => [p, sessions?.profilesOf(p) ?? []]));
  const running = sessions ? paths.reduce((n, p) => n + working(sessions, p), 0) : 0;
  const waiting = needs.count;
  // Wait times in the inbox are read at render, like every other age on screen.
  const now = Date.now();
  const unreadMap: Record<string, boolean> = Object.fromEntries(paths.map((p) => [p, sessions?.unread(p) ?? false]));
  const sleepableMap: Record<string, boolean> = Object.fromEntries(paths.map((p) => [p, sessions?.sleepable(p) ?? false]));
  const asleepMap: Record<string, boolean> = Object.fromEntries(paths.map((p) => [p, sessions?.asleep(p) ?? false]));

  const all = repos?.flatMap((r) => r.worktrees) ?? [];
  // A stored path that no longer exists falls back to the first worktree.
  const current = all.find((w) => w.path === selected) ?? all[0] ?? null;

  const { livePorts, stopPort } = useShellCardPorts({ ports, prefs, all, t });

  // Auto sleep: once a minute, tabs of finished agents that nobody looks at and that went quiet sleep.
  // The inputs sit in a ref, so a worktree switch does not restart the timer; the settings are read on each tick.
  const sleepLive = useRef({ paths, current: current?.path ?? null });
  sleepLive.current = { paths, current: current?.path ?? null };
  useEffect(() => {
    if (!sessions) return;
    return startAutoSleep({
      tickMs: AUTO_SLEEP_TICK_MS,
      settings: () => api.agentsSettings(),
      tabs: () => sleepLive.current.paths.flatMap((p) => sessions.tabs(p)),
      // The worktree on screen is never touched.
      onScreen: () => new Set(sleepLive.current.current ? sessions.tabs(sleepLive.current.current).map((t) => t.id) : []),
      lastOutput: (id) => sessions.lastOutput(id),
      now: () => Date.now(),
      sleep: (id) => sessions.hibernate(id, sessionFallback(api)),
    });
  }, [api, sessions]);
  const currentRepo = repos?.find((r) => r.worktrees.some((w) => w.path === current?.path)) ?? null;
  const branch = current ? (current.branch ?? t("workspace.detached")) : null;
  // The header names where the user is: repo and branch, the docs folder and doc, or the place.
  const placeLabel: Partial<Record<typeof view, string>> = { tasks: t("apps.tasks"), squads: t("apps.squads"), kit: t("apps.kit"), accounts: t("apps.accounts"), automations: t("workspace.nav.automations") };
  const crumbs: { text: string; mono?: boolean }[] =
    view === "workspace"
      ? currentRepo && current ? [{ text: currentRepo.shortName }, { text: branch ?? "", mono: true }] : []
      : view === "docs"
        ? docsStatus?.folder ? [{ text: docsStatus.folder }, ...(docsStatus.doc ? [{ text: docsStatus.doc, mono: true }] : [])] : []
        : placeLabel[view] ? [{ text: placeLabel[view] as string }] : [];
  // Noted during render, so the first frame of a worktree already has its tabs.
  const seen = current && !visited.includes(current.path) ? [...visited, current.path] : visited;
  if (seen !== visited) setVisited(seen);
  const mounted = seen.filter((p) => paths.includes(p));

  const count = current && changeCount?.worktree === current.path ? changeCount.count : 0;
  // Failed and cancelled runs both count, as in `checksSummary`.
  const failing = (current ? prs.get(current.path)?.checks ?? [] : []).filter((c) => c.bucket === "fail" || c.bucket === "cancel").length;
  const prMap: Record<string, { pr: PrView | null; checks: Check[] | null }> = {};
  for (const p of paths) {
    const entry = prs.get(p);
    if (entry) prMap[p] = { pr: entry.pr, checks: entry.checks };
  }
  const currentPath = current?.path;
  // The pull request of the worktree in front, read when it is selected and when the window returns.
  useEffect(() => {
    if (!currentPath) return;
    void prs.load(currentPath);
    const again = () => void prs.load(currentPath);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [prs, currentPath]);
  const markedChanges = current && changeList?.worktree === current.path ? changeList.list : NO_CHANGES;

  useShellServices({ api, sessions, view, current, panes, statusSettings, feed, live });

  const { inboxOpen, setInboxOpen, unreadTabs, unreadCount } = useShellNotifications({ api, sessions, statusSettings, live });
  // The bell: every unread tab (the events switched on), newest first; a toggle marks a row read or unread.
  const [bellOpen, setBellOpen] = useState(false);
  function toggleBell(): void {
    const next = !bellOpen;
    setBellOpen(next);
    if (!next) return;
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
      document.querySelector<HTMLElement>(".ws-bell-pop [role=menuitem], .ws-bell-pop")?.focus();
    }, 0);
  }

  // Brings a tab's worktree up, puts the tab in front and gives its terminal the keys.
  /** Shows the sessions view of the sidebar; `reveal` marks one session, else the search box takes focus. */
  function openSessionsPanel(sessionId: string | null): void {
    const key = sessionId === null ? null : history?.state.rows.find((r) => r.session.id === sessionId)?.session.key ?? null;
    setSidebarOpen(true);
    setSideView("sessions");
    setSessionsAsk((a) => ({ seq: a.seq + 1, focus: key === null, reveal: key === null ? null : { key, seq: a.seq + 1 } }));
  }
  const showInHistory = (sessionId: string) => openSessionsPanel(sessionId);

  function jumpTo(id: string): boolean {
    if (!sessions) return false;
    const tab = sessions
      .worktrees()
      .flatMap((w) => sessions.tabs(w))
      .find((x) => x.id === id);
    const wt = tab ? all.find((w) => w.path === tab.worktree) : undefined;
    if (!tab || !wt) return false;
    select(wt);
    show("workspace");
    setInboxOpen(false);
    setFront((f) => ({ worktree: wt.path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
    // The pane shows after this render; its terminal is looked up then.
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
      const pane = [...document.querySelectorAll<HTMLElement>(".ws-tab-pane")].find((el) => el.dataset.tab === tab.id);
      pane?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
      flash(pane ?? null);
    }, 0);
    return true;
  }
  live.repos = repos;
  live.t = t;
  live.jump = jumpTo;
  live.openShortcuts = (action) => openSettings("keys", action);
  live.deleteKey = () => deleteKey();
  // `openFile()` from anywhere: the file joins its worktree's tabs and comes to the front there.
  live.openFileTab = (req) => {
    const wt = all.find((w) => w.path === req.worktree);
    if (!wt) return;
    fileTabs.open(req.worktree, req.rel, req);
    select(wt);
    show("workspace");
    setFront((f) => ({ worktree: wt.path, id: fileTabId(req.rel), seq: (f?.seq ?? 0) + 1 }));
  };
  useEffect(() => onOpenFile((req) => live.openFileTab(req)), [live]);
  live.openDiff = (worktree, file, base) => {
    const wt = all.find((w) => w.path === worktree);
    if (!wt) return;
    select(wt);
    show("workspace");
    setReveal((r) => ({ worktree, file, seq: (r?.seq ?? 0) + 1, ...(base ? { base } : {}) }));
  };
  // Settings asks for the tab of a running terminal; the latest render knows where it is.
  useEffect(() => onTabJump((id) => live.jump(id)), [live]);
  live.selected = current?.path ?? null;
  live.reload = () => void load();
  // A worktree the backend made (a worker's `--worktree new-*`) has had no setup: run the same flow the UI runs
  // after a create, so `inherit` holds the agent until it ends. Not for one set up already or with setup under way.
  live.prepareSetup = async (path) => {
    if (setupRan.current.has(path) || gate.setupTab(path) !== null) return;
    setupRan.current.add(path);
    const find = (list: RepoView[] | null) => list?.find((r) => r.worktrees.some((w) => w.path === path));
    const repo = find(live.repos) ?? find(await load());
    if (repo) await setupAfterCreate(path, repo.id);
  };
  // A worktree a worker opens in must be listed and shown (hidden) so its tabs mount and start a pty.
  live.ensureMounted = (w) => {
    setVisited((v) => (v.includes(w) ? v : [...v, w]));
    if (!live.repos?.some((r) => r.worktrees.some((x) => x.path === w))) live.reload();
  };
  // `xdev worktree create --agent/--prompt`: the profile opens unfocused and gets the prompt once setup lets agents start.
  live.cliOpen = (worktree, profile, prompt, o) => void openDefaultAgent(worktree, profile || undefined, prompt ?? undefined, o);
  // A worktree made for an automation run: `run` starts its setup, `inherit` only when the repo's setup is trusted with a Run policy.
  live.automationSetup = async (worktree, _repoId, decision) => {
    if (decision === "skip") return;
    try {
      const hooks = await api.repoHooks(worktree);
      if (hooks.setup && (decision === "run" || decideSetup(hooks).step === "run")) startSetup(worktree, hooks);
    } catch {
      // The run goes on without setup.
    }
  };
  // The app CLI: the tabs as `xdev terminal` sees them, and what its endpoint asks of the window.
  useEffect(() => {
    if (!sessions) return;
    const reporter = startCliReport(api, sessions, () => live.selected);
    live.cliPoke = reporter.poke;
    const stopEvents = startCliEvents(api, {
      reload: () => live.reload(),
      openTab: (w, p, prompt, o) => live.cliOpen(w, p, prompt, o),
      openDiff: (w, f, b) => live.openDiff(w, f, b),
      markUnread: (w, unread) => (unread ? sessions.markUnread(w) : sessions.markRead(w)),
      t: (key, vars) => live.t(key, vars),
    });
    const stopTerminal = startCliTerminal(api, { sessions, ensureMounted: (w) => live.ensureMounted(w), jump: (id) => live.jump(id) });
    // Worker tabs the backend asks for, closes and reads (orchestration).
    const stopOrchestration = startOrchestrationEvents(api, {
      sessions,
      gate,
      send: (worktree, id, text, timeoutMs) => sendToOpenedTab(sessions, worktree, id, text, { timeoutMs }),
      terminal: terminalOf,
      ensureMounted: (w) => live.ensureMounted(w),
      prepareSetup: (w) => live.prepareSetup(w),
      failed: (open, stage) => void openFailedToast(open, stage, (key, vars) => live.t(key, vars)),
      reveal: (tab) => void live.jump(tab),
    });
    return () => {
      reporter.stop();
      stopEvents();
      stopTerminal();
      stopOrchestration();
      live.cliPoke = () => {};
    };
  }, [api, sessions, gate]);
  // Scheduled runs: the backend asks for a tab, the window opens it and reports back; this also says the window is ready,
  // so it waits for the layout restore.
  useEffect(() => {
    if (!sessions || !restored) return;
    return startAutomationDispatch(api, {
      sessions,
      ensureMounted: (w) => live.ensureMounted(w),
      setup: (worktree, repoId, decision) => live.automationSetup(worktree, repoId, decision),
      defer: (worktree, launch) => gate.defer(worktree, launch),
      terminalLines: (id, max) => terminalOf(id)?.lines(max) ?? null,
    });
  }, [api, sessions, gate, restored]);
  const selectedPath = current?.path ?? null;
  useEffect(() => live.cliPoke(), [selectedPath]);
  useEffect(() => onOpenFile((req) => recentFiles.touch(req.worktree, req.rel)), []);
  // Ctrl+Enter in quick open: the file goes into a new pane to the right of the focused one.
  function openFileSide(worktree: string, rel: string, line?: number, column?: number): void {
    const layout = sessions?.layout(worktree);
    const id = fileTabId(rel);
    if (sessions && layout && !paneOf(layout, id)) sessions.setLayout(worktree, splitPane(layout, layout.focused, "right", id));
    requestOpenFile({ worktree, rel, line, column });
  }
  useEffect(() => startAutosave(api, fileTabs, t), [api, t]);
  const fsWatch = useWorktreeWatch(api, current?.path ?? null, { api, store: fileTabs, t });


  function openFile(worktree: string, file: string): void {
    setReveal((r) => ({ worktree, file, seq: (r?.seq ?? 0) + 1 }));
  }

  function openCommit(worktree: string, id: string, file: string | null): void {
    setCommitAsk((c) => ({ worktree, id, file, seq: (c?.seq ?? 0) + 1 }));
  }

  function select(wt: WorktreeView): void {
    setSelected(wt.path);
    storeSelected(wt.path);
  }

  // Back / forward through the worktrees visited; always ends in the workspace view.
  const nav = useNavHistory({
    current: current?.path ?? null,
    tab: current ? (shownTab[current.path] ?? null) : null,
    alive: (path) => all.some((w) => w.path === path),
    go: (entry) => {
      const wt = all.find((w) => w.path === entry.worktree);
      if (!wt) return;
      select(wt);
      show("workspace");
      if (entry.tab && sessions?.tabs(wt.path).some((x) => x.id === entry.tab)) {
        const id = entry.tab;
        setFront((f) => ({ worktree: wt.path, id, seq: (f?.seq ?? 0) + 1 }));
      }
      focusTerminal(wt.path);
    },
  });

  // Ctrl+Shift+Up / Down and Ctrl+1..9: walk the worktrees as the sidebar draws them.
  function worktreeKey(to: { step: 1 | -1 } | { nth: number }): boolean {
    const path = worktreeTarget(order, current?.path ?? null, to);
    const wt = path === null ? undefined : all.find((w) => w.path === path);
    if (!wt) return false;
    select(wt);
    focusTerminal(wt.path);
    return true;
  }
  // The terminal key toast words itself with the latest render's `t` and sends its button to the page.
  useEffect(() => {
    setTerminalKeyHost({ t: (key, vars) => live.t(key, vars), openShortcuts: (action) => live.openShortcuts(action) });
    const stop = startDiagnosticToasts();
    return () => {
      stop();
      setTerminalKeyHost(null);
    };
  }, [live]);
  // macOS: which keyboard layout is active decides what "Option as Alt: auto" does.
  useEffect(() => (IS_MAC ? startOptionAsAltProbe(() => api.keyboardInputSource()) : undefined), []);
  // Files dropped from the OS go to the terminal pane under the pointer, as paths quoted for the pane's shell.
  useEffect(
    () =>
      startFileDrop({
        listen: async (cb) => getCurrentWebview().onDragDropEvent((e) => cb(e.payload as DropEvent)),
        scale: () => window.devicePixelRatio || 1,
        hit: (x, y) => document.elementFromPoint(x, y),
        onError: () => pushToast({ text: live.t("terminal.input.dropFailed") }),
        onRejected: () => pushToast({ text: live.t("terminal.input.dropRejected") }),
      }),
    [live],
  );
  // The stored zoom is applied once, as the shell mounts.
  useEffect(() => {
    void loadZoom(api);
  }, []);
  // Keys that work in every view; the worktree keys below need the workspace.
  live.openPrTab = openPrTab;
  live.openPrPage = () => openPrPage(current?.path ?? null);
  useEffect(() => onPrPanelOpen(() => live.openPrTab()), []);
  useEffect(() => onPrPageOpen(() => live.openPrPage()), []);
  useEffect(() => startQuickCommands(api), [api]);
  useShellLabels(api);
  useCaptureFailures(api);
  // Native menu and tray items; the latest handlers run through a ref so the listener binds once.
  const menuRun = useRef<(action: MenuAction) => void>(() => {});
  menuRun.current = (action) =>
    runMenuAction(action, {
      openSettings: () => openSettings(undefined, undefined, undefined, true),
      openShortcuts: () => openSettings("keys"),
      openUpdates,
      confirmQuitEndAll: () => setConfirmEndAll(true),
      zoom: (delta) => void stepZoom(api, delta),
      toggleLeftSidebar: () => setSidebarOpen((o) => !o),
      toggleRightSidebar: () => setRightOpen((o) => !o),
      openAbout: () => openAbout(),
    });
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void api.onMenuAction((action) => menuRun.current(action)).then((un) => {
      if (gone) un();
      else off = un;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [api]);
  useKeymap({
    "sessions.open": () => {
      show("workspace");
      openSessionsPanel(null);
    },
    "search.open": () => openSearch(isNarrow(), () => setNavOpen(true)),
    "quickOpen.open": () => {
      if (!current) {
        pushToast({ text: t("quickOpen.noWorktree") });
        return;
      }
      setQuickOpen(true);
    },
    "settings.open": () => openSettings(undefined, undefined, undefined, true),
    "quickCommands.open": () => setQuickSeq((n) => n + 1),
    "settings.shortcuts": () => openSettings("keys"),
    "worktree.history.back": () => nav.back(),
    "worktree.history.forward": () => nav.forward(),
    "sidebar.left.toggle": () => setSidebarOpen((o) => !o),
    "sidebar.right.toggle": () => setRightOpen((o) => !o),
    "panel.explorer": () => panelKey("files"),
    "panel.search": () => {
      show("workspace");
      setRightOpen(true);
      focusSearch();
    },
    "panel.sourceControl": () => panelKey("changes"),
    "panel.issues": () => panelKey("issues"),
    "panel.ports": () => panelKey("ports"),
    // In a focused terminal the chord changes the terminal font size; elsewhere it zooms the window.
    "zoom.in": (e) => void (eventInTerminal(e) ? stepTerminalFont(api, FONT_STEP) : stepZoom(api, ZOOM_STEP)),
    "zoom.out": (e) => void (eventInTerminal(e) ? stepTerminalFont(api, -FONT_STEP) : stepZoom(api, -ZOOM_STEP)),
    "zoom.reset": (e) => void (eventInTerminal(e) ? stepTerminalFont(api, 0) : stepZoom(api, 0)),
  });
  useKeymap(
    {
      "worktree.next": () => worktreeKey({ step: 1 }),
      "worktree.prev": () => worktreeKey({ step: -1 }),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`worktree.select.${n}` as ActionId, () => worktreeKey({ nth: n })])),
    },
    { when: () => view === "workspace" && !dialogOpen && !jumpOpen && !quickOpen },
  );

  // The Open In apps for the worktree menu; read again when Settings changes them.
  useEffect(() => {
    const read = () => void api.openInSettings().then((s) => setOpenInApps(s.apps), () => {});
    read();
    return api.onSettingsChanged(({ sections }) => {
      if (sections.includes("openIn")) read();
    });
  }, [api]);

  // A failed open says why in a toast, with a way to the list of apps.
  async function openIn(path: string, target: OpenTarget): Promise<void> {
    try {
      await api.openIn(path, target);
    } catch (e) {
      const err = toApiError(e);
      const name = target.type === "app" ? (openInApps.find((a) => a.id === target.id)?.label ?? target.id) : t("openIn.fileManager");
      pushToast({
        text: err.code === "not_found" ? t("openIn.notFound", { name }) : t("openIn.failed", { name, message: err.detail ?? t(`error.${err.code}`) }),
        actions: [{ label: t("openIn.editApps"), run: () => openSettings("openIn") }],
      });
    }
  }

  async function copy(text: string): Promise<void> {
    if (!(await copyText(text))) pushToast({ text: t("worktreeMenu.copyFailed") });
  }

  // A shell tab in a worktree, from the row menu: the default shell when it is on, else the first one.
  async function newTerminalIn(wt: WorktreeView, dir?: string): Promise<void> {
    if (!sessions) return;
    try {
      const pv = await api.profiles();
      const shell = pv.shells.some((s) => s.id === pv.defaultShell) ? pv.defaultShell : pv.shells[0]?.id;
      if (!shell) return;
      sessions.open(wt.path, shell, null, undefined, dir ? { dir } : {});
      select(wt);
      show("workspace");
      focusTerminal(wt.path);
    } catch {
      // The profile list did not load; the + menu of the tab strip still works.
    }
  }

  const repo = useShellRepoActions({ api, t, sessions, load, setNotice, setPrefs, select, show });
  const {
    groupName, setGroupName, editing, setEditing, forgetting, setForgetting, adding, setAdding, addingRemote, setAddingRemote, scanRoot, setScanRoot,
    forgetRepo, addRepo, addRepoFolder, addPaths, addScanned, sidebarCall, changePrefs, saveGroup, addFolder, openFolder, repoCloned, projectCreated, pin, adopt,
    setDetails, saveDetails,
  } = repo;

  const setup = useShellSetup({ api, t, sessions, gate, repos, remove: () => remove(), setRemoving: (next) => setRemoving(next) });
  const {
    cards, trusting, setTrusting, setupRan, setupAfterCreate, openTabsFor, startSetup, askArchiveTrust, runSetup, confirmTrust, dropCard, cardFor,
  } = setup;
  const selectable = order.filter((p) => !(repos ?? []).some((r) => r.worktrees.some((w) => w.path === p && w.primary)));

  const cr = useShellCreate({
    api, t, sessions, gate, repos, currentRepo, all, setupRan, load, setNotice, select, openSettings,
    setupAfterCreate,
  });
  const {
    creating, setCreating, createTab, pending, startCreate, create, startFromIssue, startFromPr, startFromMr, openDefaultAgent, startBoardAgent,
  } = cr;
  const rm = useShellRemove({
    api, t, sessions, all, current, items, picked, setPicked, view, dialogOpen: () => dialogOpen, askBeforeDeleteWorktree, alwaysForceDeleteWorktrees,
    alwaysDeleteKeptBranches, load, setNotice, openSettings, sidebarCall, askArchiveTrust,
  });
  const {
    bulk, setBulk, review, setReview, removing, setRemoving, removeRun, keptNotice, skipDeleteConfirm, openBulk, confirmBulk,
    bulkEach, deleteKey, startRemove, reviewKept, reviewDo, archiveRemoving, archive, remove,
  } = rm;
  // Not over a worktree dialog: it is modal, and the palette would stack on top of it.
  const dialogOpen = creating !== null || removing !== null || adding || groupName !== null || editing !== null || renaming !== null || checkingOut !== null || bulk !== null || review !== null;
  useJumpKey(useCallback(() => setJumpOpen((o) => (dialogOpen ? false : !o)), [dialogOpen]));


  /** Help, tray and native menu "Check for updates": shows the page, and starts the check (a check already running is joined). */
  function openUpdates(): void {
    checkForUpdates({ openSettings, api });
  }

  function pickHelp(pick: HelpPick): void {
    runHelpPick(pick, { openSettings: (page) => openSettings(page), openUpdates, openAbout, toast: (key) => pushToast({ text: t(key) }), api });
  }

  const remoteActs = useShellRemoteActions({ api, t, sessions, remote });
  const { pendingReconnect, reconnectRemote, disconnectRemote, removeRemote } = remoteActs;

  // "Try it" on the feature wall opens the page or panel.
  const tryFeatureRef = useRef<(target: { kind: string; section?: string }) => void>(() => {});
  tryFeatureRef.current = (target) => {
    if (target.kind === "settings") openSettings(target.section);
    else { setSidebarOpen(true); setSideView("activity"); show("workspace"); }
  };
  useEffect(() => onTryFeature((target) => tryFeatureRef.current(target)), []);

  const fix = useShellAgentFix({ api, sessions, current, shownTab, prComments, target, setFront });
  const { fixNote, setFixNote, sendToAgent, fixWithAgent, resolveConflicts, fixChecks, fixCheck, sendComments } = fix;

  const removingRepo = removing ? repos?.find((r) => r.worktrees.some((w) => w.path === removing.worktree.path)) : undefined;

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.profiles()).then((v) => live && v && setNameView(v), () => undefined);
    return () => void (live = false);
  }, [api]);

  const hiddenApps = useHiddenApps();
  const appOrder = useAppOrder();
  const places = railPlaces(hiddenApps, appOrder, automationsSettings.showButton);

  // A place from the narrow bottom bar.
  function pickNarrow(place: NarrowPlace): void {
    setNavOpen(false);
    if (place === "sessions") show("workspace");
    else if (place === "tasks") openTaskBoard();
    else if (place === "accounts") openAccounts();
    else if (place === "settings") openSettings();
    else show(place);
  }

  return (
    <ProfilesProvider api={api}>
    <UpsellHost api={api}>
    <ShellFrame
      titlebar={<Titlebar />}
      view={view}
      onView={(next) => show(next)}
      places={places}
      labels={{
        workspace: t("workspace.nav.workspace"),
        docs: t("workspace.nav.docs"),
        tasks: t("apps.tasks"),
        squads: t("apps.squads"),
        kit: t("apps.kit"),
        accounts: t("apps.accounts"),
        automations: t("workspace.nav.automations"),
        rail: t("workspace.nav.label"),
        sidebar: t("workspace.sidebar"),
        openNav: t("shell.nav.open"),
        closeNav: t("shell.nav.close"),
        skipToContent: t("shell.skipToContent"),
      }}
      sidebarOpen={sidebarOpen}
      navOpen={navOpen}
      onNavOpenChange={setNavOpen}
      bottomNav={<NarrowNav view={view} automations={automationsSettings.showButton} places={places} onPick={pickNarrow} />}
      brand={
        <>
          <BrandMark className="ws-logo" size={18} />
          <span className="ws-brand">xDev</span>
        </>
      }
      crumbs={
        <div className="ws-header">
        <button
          type="button"
          className="ws-icon-btn ws-sidebar-toggle"
          aria-label={t("workspace.toggleSidebar")}
          title={t("workspace.toggleSidebar")}
          aria-expanded={sidebarOpen}
          aria-controls="ws-sidebar"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <Icon name="sidebar" size={16} />
        </button>
        <NavButtons canBack={nav.canBack} canForward={nav.canForward} onBack={nav.back} onForward={nav.forward} />
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            <span className="ws-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className={c.mono ? "ws-crumb ws-mono" : "ws-crumb"}>{c.text}</span>
          </Fragment>
        ))}
        <div className="ws-header-center">
          <HeaderSearch onOpen={() => openSearch(isNarrow(), () => setNavOpen(true))} onJump={() => setJumpOpen(true)} />
        </div>
        </div>
      }
      actions={
        <>
        {/* The bell: the unread tabs, newest first. Turned off in Settings it shows nothing. */}
        <div className="ws-bell">
          <button
            type="button"
            className="ws-icon-btn ws-header-btn"
            disabled={!statusSettings.bell}
            aria-label={statusSettings.bell && unreadCount > 0 ? t("status.bell.label", { count: unreadCount }) : t("workspace.header.notifications")}
            title={statusSettings.bell ? t("workspace.header.notifications") : t("status.bell.off")}
            aria-haspopup="menu"
            aria-expanded={statusSettings.bell && bellOpen}
            onClick={toggleBell}
          >
            <Icon name="inbox" size={16} />
            {statusSettings.bell && unreadCount > 0 && (
              <span className="ws-bell-count" aria-hidden="true">
                {bellCount(unreadCount)}
              </span>
            )}
          </button>
          {statusSettings.bell && bellOpen && (
            <BellMenu
              rows={unreadTabs.map((tab): BellRow => ({ tab, worktree: worktreeName(all, tab.worktree), name: tab.title ?? profileName(nameView, tab.profileId, t) }))}
              now={Date.now()}
              onJump={(tab) => void jumpTo(tab.id)}
              onToggleRead={(tab) => (tab.unread ? sessions?.markTabRead(tab.id) : sessions?.markTabUnread(tab.id))}
              onViewActivity={() => { setBellOpen(false); setSidebarOpen(true); setSideView("activity"); setActivityAsk((a) => ({ tab: "feed", seq: a.seq + 1 })); }}
              onClose={() => setBellOpen(false)}
            />
          )}
        </div>
        {/* What waits on the person, longest first. Turned off in Settings it shows nothing. */}
        {statusSettings.bell && (
          <AttentionInbox
            items={needs.entries.map((e) => ({
              id: e.tab.id,
              agent: agentOf(e.tab),
              worktree: worktreeName(all, e.tab.worktree),
              text: e.ask ?? e.tab.title ?? profileName(nameView, e.tab.profileId, t),
              since: e.since,
              kind: e.kind,
            }))}
            onOpen={(id) => void jumpTo(id)}
            open={inboxOpen}
            onOpenChange={setInboxOpen}
            now={now}
            labels={{
              title: t("needsYou.title"),
              button: (count) => t("needsYou.button", { count }),
              empty: t("needsYou.empty"),
              open: t("needsYou.open"),
              openItem: (item) => t("needsYou.openItem", { worktree: item.worktree }),
              kind: { approval: t("needsYou.kind.approval"), question: t("needsYou.kind.question"), failed: t("needsYou.kind.failed") },
              waited: (ms) => ago(now - ms, now, t),
            }}
          />
        )}
        {view === "workspace" && <LayoutControls api={api} sessions={sessions} worktree={current?.path ?? null} />}
        <HelpButton onPick={pickHelp} />
        <button
          type="button"
          className="ws-icon-btn ws-header-btn"
          aria-label={t("workspace.header.settings")}
          title={t("workspace.header.settings")}
          aria-pressed={view === "settings"}
          onClick={() => {
            // The gear opens the first section, not one the palette asked for earlier.
            setSettingsAt((s) => ({ seq: s.seq }));
            show("settings");
          }}
        >
          <Icon name="settings" size={16} />
        </button>
        </>
      }
      sidebar={
        <ShellSidebar
          repo={repo} rm={rm} remoteActs={remoteActs} views={views} panels={panels} cr={cr} dialogs={dialogs}
          api={api} navRef={setNavSlot} t={t} sessions={sessions} history={history} repos={repos} all={all} current={current} items={items} prefs={prefs}
          picked={picked} setPicked={setPicked} selectable={selectable} setOrder={setOrder} sideView={sideView} setSideView={setSideView}
          sidebarOpen={sidebarOpen} sessionsAsk={sessionsAsk} activityAsk={activityAsk} feed={feed} stats={stats} dots={dots} activity={activity}
          profiles={profiles} unreadMap={unreadMap} asleepMap={asleepMap} sleepableMap={sleepableMap} prMap={prMap} nameView={nameView}
          livePorts={livePorts} stopPort={stopPort} notice={notice} openInApps={openInApps} remote={remote} jumpTo={jumpTo} select={select}
          copy={copy} openIn={openIn} newTerminalIn={newTerminalIn}
        />
      }
      footer={
      <LiveWorkspaceFooter
        api={api}
        branch={branch}
        running={running}
        waiting={waiting}
        version={pkg.version}
        onOpenUsage={openUsage}
        onManageAccounts={openAccounts}
        onUsageSettings={() => openSettings("usage")}
        onUseAccount={pickAccount}
        ports={<PortsItem store={ports} active={current?.path ?? null} onOpen={() => panelKey("ports")} />}
        onManageSsh={() => openSettings("ssh")}
        onOpenLicense={() => openSettings("account")}
        floating={<FloatingItem />}
        onOpenSshTerminal={current && sessions ? (alias) => void sessions.open(current.path, `${SSH_SHELL_PREFIX}${alias}`, null, null) : undefined}
        docs={view === "docs" && docsStatus ? docsStatusItems(docsStatus, t, openDocsSection) : undefined}
      />
      }
      overlays={
        <ShellOverlays
          repo={repo} rm={rm} cr={cr} setup={setup} remoteActs={remoteActs} acct={acct} views={views} panels={panels} layout={layout} dialogs={dialogs}
          api={api} t={t} history={history} sessions={sessions} repos={repos} all={all} current={current} dots={dots} profiles={profiles} nameView={nameView}
          shownTab={shownTab} remote={remote} removingRepo={removingRepo} gate={gate} live={live} dialogOpen={dialogOpen} load={load} select={select}
          jumpTo={jumpTo} focusTerminal={focusTerminal} openFileSide={openFileSide} openSessionsPanel={openSessionsPanel} setNotice={setNotice}
          setSidebarOpen={setSidebarOpen} setFront={setFront}
        />
      }
    >
        <WorkspaceStage
          repo={repo} setup={setup} fix={fix} panels={panels} views={views} remoteActs={remoteActs} cr={cr}
          api={api} t={t} sessions={sessions} repos={repos} all={all} current={current} currentRepo={currentRepo} mounted={mounted} count={count}
          failing={failing} markedChanges={markedChanges} front={front} setFront={setFront} shownTab={shownTab} setShownTab={setShownTab}
          setPanes={setPanes} reveal={reveal} commitAsk={commitAsk} termFocus={termFocus} quickSeq={quickSeq} prs={prs} prComments={prComments}
          ports={ports} fsWatch={fsWatch} gate={gate} live={live} remote={remote} jumpTo={jumpTo} showInHistory={showInHistory} openFile={openFile}
          openCommit={openCommit} newTerminalIn={newTerminalIn}
        />

        <div className="ws-docs" hidden={view !== "docs"}>
          {placesMounted.has("docs") && <SurfaceBoundary id="page.docs" surface="Docs" resetKey={docsKey} titleKey="boundary.page.title"><DocsHost
            key={docsKey}
            ref={docsRef}
            api={api}
            navSlot={navSlot}
            request={docsRequest}
            onStatus={setDocsStatus}
            onOpenSection={openDocsSection}
            vaultNav={<VaultNav api={api} canOpen={() => docsRef.current?.flush() ?? true} onOpened={() => setDocsKey((k) => k + 1)} />}
          /></SurfaceBoundary>}
        </div>
        <PlaceStage
          api={api}
          view={view}
          mounted={placesMounted}
          tasks={tasksRequest}
          board={{ repos, defaultRepo: repoOf(repos, current), sessions, current: current ? { path: current.path, branch: current.branch } : null, onStart: startBoardAgent, onOpenTab: (l) => void jumpTo(l.tabId) }}
          kit={{ worktree: current?.path ?? null, open: null, onSendToAgent: sendToAgent, canSend: target(current?.path) !== null }}
          onOpenTask={openTask}
          onOpenAgentContext={() => openDocsSection("agents")}
        />

        <div className="ws-automations" hidden={view !== "automations"}>
          {view === "automations" && (
            <AutomationsPage
              api={api}
              repos={repos}
              openSettings={(section) => openSettings(section)}
              onOpenWorkspace={(path) => {
                const wt = all.find((w) => w.path === path);
                if (wt) select(wt);
                show("workspace");
              }}
            />
          )}
        </div>

        <div className="ws-settings" hidden={view !== "settings"}>
          {view === "settings" && (
            <SettingsView
              key={settingsAt.seq}
              api={api}
              initial={settingsAt.section}
              arg={settingsAt.arg}
              target={settingsAt.target}
              openView={(v) => show(v as View)}
              openTerminal={(profile, title) => {
                if (!sessions || !current) return null;
                const tab = sessions.open(current.path, profile);
                sessions.rename(tab.id, title);
                show("workspace");
                focusTerminal(current.path);
                return tab.id;
              }}
              onChanged={() => {
                void load();
                void loadStatusSettings(api);
              }}
            />
          )}
        </div>
    </ShellFrame>
    </UpsellHost>
    </ProfilesProvider>
  );
}
