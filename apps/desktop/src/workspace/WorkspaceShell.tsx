import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import pkg from "../../package.json";
import { BrandMark } from "@/components/BrandMark";
import { ProfilesProvider, SSH_SHELL_PREFIX, profileName } from "@/agents/profileStore";
import { SETUP_PROFILE, toApiError, type Api, type ApiError, type Check, type Created, type Linked, type OpenInApp, type OpenTarget, type HookDetail, type ScriptKind, type RepoHooks, type PrView, type PtyProfile, type DetailsPatch, type KeptBranch, type RepoGroup, type FolderEntry, type WorkStatus, type SidebarItem, type SidebarPrefs, type RepoView, type WorktreeChange, type WorktreeView, type Issue, type IssueDetail, type CreateRequest, type PrSummary, type MrSummary, type MenuAction, type SetupDecision, type BaseDrift, type Provider, type ProfilesView } from "@/api";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { DocsApp } from "@/DocsApp";
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
import { BellMenu, bellCount, type BellRow } from "./BellMenu";
import { ActivityPanel, type ActivityTab } from "@/activity/ActivityPanel";
import { ActivityFeed } from "@/activity/feed";
import { Button, Icon } from "@xdev-asia/ui";
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
import { useShellRemove } from "@/shell/useShellRemove";
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
  AUTO_SLEEP_TICK_MS, NO_CHANGES, readSelected, storeSelected, waitingIn, windowFocused, working, worktreeName,
  type BulkState, type Creating, type Editing, type PanelTab, type Removing, type Review, type SetupCardAt, type TrustAsk, type View,
} from "./shellModel";
import { runWithToast } from "@/quickCommands/runUi";
import { startQuickCommands } from "@/quickCommands/store";


/** The app frame: repos and worktrees on the left, the selected worktree in the middle. */
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
  // The group name dialog: `id` null makes a new group.
  // The multi-selection, the bulk delete or archive dialog, and the branch review.
  const [picked, setPicked] = useState<Selection>(clearPicked);
  const [groupName, setGroupName] = useState<{ id: string | null; name: string; error?: ApiError["code"] } | null>(null);
  const [selected, setSelected] = useState<string | null>(() => readSelected());
  const { view, show, docsMounted, setDocsMounted, kitOpen, appRequest, docsKey, setDocsKey, settingsAt, setSettingsAt, openSettings, openUsage, openTask, openTaskBoard, openDecompose, openAccounts, kitOpened, openSearch, docsSaved } = useShellViews();
  // Agent and shell names for the merge headings and the resource manager rows.
  const [nameView, setNameView] = useState<ProfilesView | null>(null);
  const [composerAsk, setComposerAsk] = useState<ComposerRequest | null>(null);
  // The tabs whose output the merge dialog shows.
  const [mergeSources, setMergeSources] = useState<MergeSource[] | null>(null);
  // The tab in front of each worktree, which is where a prompt from the Agent kit is typed.
  const [shownTab, setShownTab] = useState<Record<string, string | null>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  // The right panel (Files / Changes / Checks); hidden, not unmounted, so its state stays.
  const [sessions, setSessions] = useState<Sessions | null>(null);
  // The agent session history, and which of the two sidebar views shows.
  const [history, setHistory] = useState<AgentSessionsStore | null>(null);
  const [sideView, setSideView] = useState<"worktrees" | "sessions" | "activity">("worktrees");
  const [feed] = useState(() => new ActivityFeed());
  const [activityAsk, setActivityAsk] = useState<{ tab: ActivityTab; seq: number }>({ tab: "threads", seq: 0 });
  // A new `seq` asks the sessions panel for the search box, or to mark one session.
  const [sessionsAsk, setSessionsAsk] = useState<{ seq: number; focus: boolean; reveal: { key: string; seq: number } | null }>({ seq: 0, focus: false, reveal: null });
  const [creating, setCreating] = useState<Creating | null>(null);
  // The tab the create dialog was last on, for the next opening of this shell.
  const createTab = useRef<CreateTab>("name");
  // Creates run after the dialog has closed; what a finished one does is read from this render.
  const afterCreate = useRef<{ api: Api; created(wt: WorktreeView, args: CreateArgs): void; reload(): void; linked(shared: Linked[]): void; behind(drift: BaseDrift): void }>({ api, created() {}, reload() {}, linked() {}, behind() {} });
  const [pending] = useState(
    () =>
      new PendingCreates({
        create: (repoId, name, from, request) => afterCreate.current.api.worktreeCreate(repoId, name, from, request).then((made) => {
          afterCreate.current.linked(made.shared);
          if (made.baseBehind) afterCreate.current.behind(made.baseBehind);
          return made.worktree;
        }),
        // Cancel was the go-ahead; a fresh worktree is clean, so its branch goes too.
        remove: (path, force) => afterCreate.current.api.worktreeRemove(path, force, true).finally(() => afterCreate.current.reload()),
        onCreated: (wt, args) => afterCreate.current.created(wt, args),
        discard: (repoId, branch) => afterCreate.current.api.prBranchDiscard(repoId, branch),
      }),
  );
  useSyncExternalStore(
    (fn) => pending.subscribe(fn),
    () => pending.version,
  );
  // Setup: the card a worktree shows, the trust prompt, and the gate that holds agents while setup runs.
  const [cards, setCards] = useState<Record<string, SetupCardAt>>({});
  const [trusting, setTrusting] = useState<TrustAsk | null>(null);
  // The About dialog (its version, once known) and the "quit and end terminals" confirmation.
  const [about, setAbout] = useState<string | null>(null);
  const [machine, setMachine] = useState("");
  const [boardOpen, setBoardOpen] = useState(false);
  const [confirmEndAll, setConfirmEndAll] = useState(false);
  const [gate] = useState(() => new SetupGate());
  // Worktrees whose setup flow already ran (made here, or run for a worker); it runs once each.
  const setupRan = useRef(new Set<string>());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState<WorktreeView | null>(null);
  const [checkingOut, setCheckingOut] = useState<WorktreeView | null>(null);
  const [parentFor, setParentFor] = useState<{ worktree: WorktreeView; candidates: WorktreeView[] } | null>(null);
  const [notice, setNotice] = useState<ApiError["code"]>();
  const [fixNote, setFixNote] = useState(false);
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
  // The jump palette, and the settings section it asked for; a new `seq` is a new request.
  const [jumpOpen, setJumpOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  // Asks the front terminal of a worktree to take keyboard focus, as the palette closes.
  const [termFocus, setTermFocus] = useState<{ worktree: string; seq: number } | null>(null);
  const focusTerminal = (worktree: string) => setTermFocus((f) => ({ worktree, seq: (f?.seq ?? 0) + 1 }));
  // The repo Remove from xDev asks about, and why the last try failed.
  const [forgetting, setForgetting] = useState<{ repo: RepoView; error?: ApiError["code"] } | null>(null);
  // The Add project dialog (Open folder… or Clone from URL).
  const [adding, setAdding] = useState(false);
  // Add project opened by the palette's remote action starts on its remote step.
  const [addingRemote, setAddingRemote] = useState(false);
  // The folder the Add project dialog opens scanning, when a picked folder held no repo itself.
  const [scanRoot, setScanRoot] = useState<string>();
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
  const {
    rightOpen, setRightOpen, changesReady, registerChanges, runOnChanges, panelTab, setPanelTab, issuesGit, issuesPinned,
    searchFocus, focusSearch, prPage, panelKey, openPrTab, openPrPage, changeCount, setChangeCount, changeList, setChangeList,
  } = useShellPanels({ api, view, show, setSidebarOpen });

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

  const { restored, quitting } = useShellLayoutRestore({ api, sessions, repos, t, live });


  const { switching, setSwitching, pickAccount, answerSwitch } = useShellAccountSwitch({
    api, sessions, t, live,
    frontTab: () => (sessions && current ? sendTarget(sessions.tabs(current.path), shownTab[current.path] ?? null) : null),
  });

  const paths = repos?.flatMap((r) => r.worktrees.map((w) => w.path)) ?? [];
  const subscribe = useCallback((listener: () => void) => sessions?.subscribe(listener) ?? (() => {}), [sessions]);
  // The live agent tab in front of a worktree, if any: where the Agent kit types.
  const target = (path: string | undefined) => (sessions && path ? sendTarget(sessions.tabs(path), shownTab[path] ?? null) : null);
  // A string, so an unchanged store reads as the same snapshot.
  const signature = () =>
    sessions
      ? paths.map((p) => `${sessions.dot(p) ?? ""}:${working(sessions, p)}:${waitingIn(sessions, p)}:${sessions.unread(p) ? "u" : ""}:${target(p)?.id ?? ""}`).join("|") +
        `#${sessions.unreadTabs().map((tab) => `${tab.id}:${tab.status}:${tab.unreadAt}`).join(",")}`
      : "";
  useSyncExternalStore(subscribe, signature, signature);
  useSyncExternalStore(useCallback((fn: () => void) => gate.subscribe(fn), [gate]), () => gate.snapshot(), () => gate.snapshot());
  useSyncExternalStore(stats.subscribe, stats.snapshot, stats.snapshot);
  useSyncExternalStore(useCallback((fn: () => void) => prs.subscribe(fn), [prs]), () => prs.snapshot(), () => prs.snapshot());

  const dots: Record<string, TabStatus | null> = Object.fromEntries(paths.map((p) => [p, sessions?.dot(p) ?? null]));
  const activity: Record<string, number | null> = Object.fromEntries(paths.map((p) => [p, sessions?.lastActivity(p) ?? null]));
  const profiles: Record<string, PtyProfile[]> = Object.fromEntries(paths.map((p) => [p, sessions?.profilesOf(p) ?? []]));
  const running = sessions ? paths.reduce((n, p) => n + working(sessions, p), 0) : 0;
  const waiting = sessions ? paths.reduce((n, p) => n + waitingIn(sessions, p), 0) : 0;
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

  const { bellOpen, setBellOpen, toggleBell, unreadCount, bellRows } = useShellNotifications({ api, sessions, statusSettings, all, t, live });

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
    setBellOpen(false);
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
    "search.open": () => openSearch(),
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

  async function forgetRepo(repo: RepoView): Promise<void> {
    const code = await removeRepo({ forget: (id) => api.repoForget(id), closeWorktree: (path) => sessions?.closeWorktree(path) }, repo);
    if (code) return setForgetting({ repo, error: code });
    setForgetting(null);
    await load();
  }

  function addRepo(): void {
    setAddingRemote(false);
    setNotice(undefined);
    setScanRoot(undefined);
    setAdding(true);
  }

  async function addRepoFolder(): Promise<void> {
    setAdding(false);
    setNotice(undefined);
    const paths = await api.pickFolders().catch(() => [] as string[]);
    if (paths.length === 0) return;
    await addPaths(paths, true);
  }

  /** Adds the folders, selects the first new worktree and says what failed. A lone folder that is no repo opens the scan step instead. */
  async function addPaths(paths: string[], offerScan: boolean): Promise<void> {
    const result = await addRepoFolders(api, paths);
    await load();
    const first = result.added[0]?.worktrees[0];
    if (first) select(first);
    if (offerScan && paths.length === 1 && result.failed[0]?.code === "no_repo") {
      setScanRoot(paths[0]);
      setAdding(true);
      return;
    }
    const notice = addFoldersNotice(result, paths.length);
    if (notice === null) return;
    if ("code" in notice) setNotice(notice.code);
    else pushToast({ text: t("addProject.openFolders.partial", notice.toast) });
  }

  async function addScanned(paths: string[]): Promise<void> {
    setAdding(false);
    setScanRoot(undefined);
    setNotice(undefined);
    await addPaths(paths, false);
  }

  async function sidebarCall(run: () => Promise<unknown>): Promise<boolean> {
    setNotice(undefined);
    try {
      await run();
      await load();
      return true;
    } catch (e) {
      setNotice(toApiError(e).code);
      return false;
    }
  }

  function changePrefs(next: SidebarPrefs): void {
    setPrefs(next);
    api.sidebarPrefsPut(next).catch((e) => setNotice(toApiError(e).code));
  }

  async function saveGroup(name: string): Promise<void> {
    if (!groupName) return;
    try {
      await api.groupPut(groupName.id, name);
      setGroupName(null);
      await load();
    } catch (e) {
      setGroupName({ ...groupName, name, error: toApiError(e).code });
    }
  }

  async function addFolder(): Promise<void> {
    const path = await api.pickFolder().catch(() => null);
    if (path) await sidebarCall(() => api.folderAdd(path));
  }

  async function openFolder(folder: FolderEntry): Promise<void> {
    if (!sessions) return;
    try {
      const pv = await api.profiles();
      const shell = pv.shells.some((s) => s.id === pv.defaultShell) ? pv.defaultShell : pv.shells[0]?.id;
      if (shell) {
        sessions.open(folder.path, shell);
        show("workspace");
      }
    } catch {
      // The profile list did not load; nothing opens.
    }
  }

  const selectable = order.filter((p) => !(repos ?? []).some((r) => r.worktrees.some((w) => w.path === p && w.primary)));

  const {
    bulk, setBulk, review, setReview, removing, setRemoving, removeRun, keptNotice, skipDeleteConfirm, openBulk, confirmBulk,
    bulkEach, deleteKey, startRemove, reviewKept, reviewDo, archiveRemoving, archive, remove,
  } = useShellRemove({
    api, t, sessions, all, current, items, picked, setPicked, view, dialogOpen: () => dialogOpen, askBeforeDeleteWorktree, alwaysForceDeleteWorktrees,
    alwaysDeleteKeptBranches, load, setNotice, openSettings, sidebarCall, askArchiveTrust: (path) => askArchiveTrust(path),
  });
  // Not over a worktree dialog: it is modal, and the palette would stack on top of it.
  const dialogOpen = creating !== null || removing !== null || adding || groupName !== null || editing !== null || renaming !== null || checkingOut !== null || bulk !== null || review !== null;
  useJumpKey(useCallback(() => setJumpOpen((o) => (dialogOpen ? false : !o)), [dialogOpen]));

  async function repoCloned(repo: RepoView): Promise<void> {
    setAdding(false);
    await load();
    if (repo.worktrees[0]) select(repo.worktrees[0]);
  }

  // A Git project is added and selected like a clone; a folder shows in the sidebar.
  async function projectCreated(created: Created): Promise<void> {
    setAdding(false);
    await load();
    if (created.kind === "git" && created.repo.worktrees[0]) select(created.repo.worktrees[0]);
  }

  async function pin(wt: WorktreeView): Promise<void> {
    setNotice(undefined);
    try {
      await api.worktreePin(wt.path, !wt.pinned);
      await load();
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  async function adopt(wt: WorktreeView): Promise<void> {
    setNotice(undefined);
    try {
      await api.worktreeAdopt(wt.path);
      await load();
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  function startCreate(repoId?: string, name?: string, status?: WorkStatus | null): void {
    const usable = repos?.filter((r) => !r.missing) ?? [];
    const id = repoId ?? (currentRepo && !currentRepo.missing ? currentRepo.id : usable[0]?.id);
    if (!id) return;
    setCreating({ repoId: id, name, status, agents: [], defaultAgent: null });
    // The agent choice arrives a moment later; the dialog is already open.
    void api
      .profiles()
      .then((v) => ({
        agents: v.profiles.filter((p) => p.profile.enabled && p.installed).map((p) => ({ id: p.profile.id, name: p.profile.name })),
        defaultAgent: v.defaultAgent as string | null,
      }))
      .then((choice) => setCreating((c) => (c ? { ...c, ...choice } : c)))
      .catch(() => {});
  }

  // The dialog closes at once; the create runs as a row in the list until it finishes or fails.
  function create(repoId: string, name: string, from: string | null, extra?: CreateExtra, request?: CreateRequest, keepOpen = false, discardBranch?: string): void {
    if (!keepOpen) setCreating(null);
    pending.start({ repoId, name, from, ...(extra ? { extra } : {}), ...(request ? { request } : {}), ...(discardBranch ? { discardBranch } : {}) });
  }

  // The issue becomes the worktree: named from it, linked as its work item, sent to the default agent.
  async function startFromIssue(repoId: string, issue: Issue, detail?: IssueDetail): Promise<void> {
    try {
      const full = detail ?? (await api.issueView(repoId, issue.number).catch(() => ({ issue, body: "", comments: [] })));
      const repo = repos?.find((r) => r.id === repoId);
      const taken = new Set((repo?.worktrees ?? []).flatMap((w) => [w.name, w.branch ?? ""]));
      const name = uniqueWorktreeName(issueWorktreeName(issue), taken);
      const view = await api.profiles().catch(() => null);
      // The repo's issue command, when it has one, in place of the built-in prompt.
      const shared = repo ? await api.repoHooks(repo.path).catch(() => null) : null;
      const template = effectiveIssueCommand(repo?.localIssueCommand ?? "", shared);
      create(repoId, name, null, {
        title: null,
        agent: view?.defaultAgent ?? null,
        setDefault: false,
        parent: null,
        item: issueWorkItem(issue),
        prompt: template === null ? issuePrompt(full, t) : renderIssueCommand(template, issueTemplateVars(full, repo?.shortName ?? "", t)),
      });
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  // The pull request becomes the worktree: its branch is put on a new worktree, linked as its work item, sent to the default agent.
  async function startFromPr(repoId: string, pr: PrSummary): Promise<void> {
    try {
      const { branch, fetched } = await api.prBranch(repoId, pr.number);
      const repo = repos?.find((r) => r.id === repoId);
      const taken = new Set((repo?.worktrees ?? []).flatMap((w) => [w.name, w.branch ?? ""]));
      const name = uniqueWorktreeName(prWorktreeName(pr), taken);
      const view = await api.profiles().catch(() => null);
      create(repoId, name, null, { title: pr.title, agent: view?.defaultAgent ?? null, setDefault: false, parent: null, item: prWorkItem(pr) }, { existing: branch, sparse: [] }, false, fetched ? branch : undefined);
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  // A merge request starts a worktree the way a pull request does, on the branch `gitlab_mr_branch` puts in place.
  async function startFromMr(repoId: string, mr: MrSummary): Promise<void> {
    try {
      const { branch, fetched } = await api.gitlabMrBranch(repoId, mr.iid);
      const repo = repos?.find((r) => r.id === repoId);
      const taken = new Set((repo?.worktrees ?? []).flatMap((w) => [w.name, w.branch ?? ""]));
      const name = uniqueWorktreeName(mrWorktreeName(mr), taken);
      const view = await api.profiles().catch(() => null);
      create(repoId, name, null, { title: mr.title, agent: view?.defaultAgent ?? null, setDefault: false, parent: null, item: mrWorkItem(mr) }, { existing: branch, sparse: [] }, false, fetched ? branch : undefined);
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  async function created(wt: WorktreeView, args: CreateArgs): Promise<void> {
    const extra = args.extra;
    if (extra) await applyCreateExtra(wt.path, extra);
    await load();
    setupRan.current.add(wt.path);
    await setupAfterCreate(wt.path, args.repoId);
    // Dialog: the agent it picked, or none. No dialog: the default agent.
    await openDefaultAgent(wt.path, extra ? extra.agent : undefined, extra?.prompt);
    select(wt);
  }
  afterCreate.current = { api, created: (wt, args) => void created(wt, args), reload: () => void load(), linked: reportLinks, behind: (drift) => void pushToast(baseBehindToast(drift, api, t)) };

  // Shared paths that did not link are said once, with the reason; the worktree is made all the same.
  function reportLinks(shared: Linked[]): void {
    const failed = failedLinks(shared);
    if (failed.length > 0) pushToast({ text: t("repoFile.linkFailed", { paths: failed.join("\n") }), ttlMs: 0 });
  }

  // The worktree is made; what the dialog added goes in one details call, and a new default agent is kept.
  async function applyCreateExtra(path: string, extra: CreateExtra): Promise<void> {
    const patch: DetailsPatch = {};
    if (extra.title !== null) patch.title = extra.title;
    if (extra.parent !== null) patch.parent = extra.parent;
    if (extra.item !== null) patch.item = extra.item;
    if (extra.note) patch.comment = extra.note;
    if (extra.status) patch.status = extra.status;
    try {
      if (Object.keys(patch).length > 0) await api.worktreeDetails(path, patch);
      if (extra.setDefault && extra.agent !== null) {
        const view = await api.profiles();
        if (view.defaultAgent !== extra.agent) await api.profilesDefaults(view.approvals, extra.agent, view.defaultShell);
      }
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  // The parent picker and the row menu's lineage and status items write straight through `worktreeDetails`.
  async function setDetails(wt: WorktreeView, patch: DetailsPatch, failure: string): Promise<void> {
    try {
      await api.worktreeDetails(wt.path, patch);
      await load();
    } catch {
      pushToast({ text: failure });
    }
  }

  async function saveDetails(patch: DetailsPatch): Promise<void> {
    if (!editing || editing.busy) return;
    const { worktree } = editing;
    if (Object.keys(patch).length === 0) return setEditing(null);
    setEditing({ worktree, busy: true });
    try {
      await api.worktreeDetails(worktree.path, patch);
      setEditing(null);
      await load();
    } catch (e) {
      setEditing({ worktree, busy: false, error: toApiError(e).code });
    }
  }

  // A new worktree starts with the agent picked for it, else the resolved default agent; with no
  // agent at all, the default shell, and nothing is typed into it. A picked agent that is off or not
  // installed opens nothing, and a toast says why: another agent never takes its place or its prompt.
  async function openDefaultAgent(path: string, pick?: string | null, prompt?: string, o: { id?: string; account?: string } = {}): Promise<Tab | null> {
    if (!sessions || pick === null) return null;
    try {
      const view = await api.profiles();
      const usable = (id: string) => view.profiles.some((p) => p.profile.id === id && p.profile.enabled && p.installed);
      if (pick !== undefined && !usable(pick)) {
        const name = view.profiles.find((p) => p.profile.id === pick)?.profile.name ?? pick;
        pushToast({
          text: t("workspace.agentUnusable", { name }),
          actions: [{ label: t("workspace.agentPicker.manage"), run: () => openSettings("agents") }],
        });
        return null;
      }
      const agent = pick ?? view.resolvedDefault;
      const shell = view.shells.some((s) => s.id === view.defaultShell) ? view.defaultShell : view.shells[0]?.id;
      const id = agent ?? shell;
      if (!id) return null;
      // The prompt goes with the agent tab: on its command line, or typed once it started.
      let opened: Tab | null = null;
      const launch = (): void => void (opened = sessions.open(path, id, o.account ?? null, undefined, { ...(agent && prompt ? { prompt } : {}), ...(o.id ? { id: o.id } : {}) }));
      // With the repo set to wait, the tab opens when the setup tab has exited.
      if (!gate.defer(path, launch)) launch();
      return opened;
    } catch {
      // The worktree is made; it just opens empty.
      return null;
    }
  }

  // The Tasks app starts an agent on a task: in a worktree it made or the current one. Resolves with the tab, to link it.
  async function startBoardAgent(req: { worktree: string; agent: string | null; prompt: string }): Promise<{ tabId: string; tabTitle: string } | null> {
    if (!all.some((w) => w.path === req.worktree)) await load();
    const tab = await openDefaultAgent(req.worktree, req.agent ?? undefined, req.prompt);
    return tab ? { tabId: tab.id, tabTitle: tab.title ?? tab.profileId } : null;
  }

  // What a new worktree does about setup. Skip never opens the setup tab; the card choices and a
  // trusted Run policy do.
  async function setupAfterCreate(path: string, repoId: string, listsAsked = false): Promise<void> {
    let hooks: RepoHooks;
    try {
      hooks = await api.repoHooks(path);
    } catch {
      return;
    }
    const todo = decideSetup(hooks);
    // The setup prompt carries the lists; alone, they are asked first and the flow goes on after.
    if (todo.step !== "trust" && !listsAsked && hasPending(pendingLists(hooks))) return askTrust(path, repoId, hooks, false, "lists");
    if (todo.step === "detected") setCards((c) => ({ ...c, [path]: { kind: "detected", command: todo.command, repoId } }));
    else if (todo.step === "ask") setCards((c) => ({ ...c, [path]: { kind: "ask", repoId } }));
    else if (todo.step === "run") startSetup(path, hooks);
    else if (todo.step === "trust") askTrust(path, repoId, hooks, false);
    // No setup will run now: the default tabs open at once.
    else void openTabsFor(path);
  }

  // The default tabs of the repo file, when the person trusted that list; a shell tab each. The hooks are read
  // again so the trust check sees the file as it is now.
  async function openTabsFor(path: string): Promise<void> {
    try {
      const hooks = await api.repoHooks(path);
      if (hooks.tabsTrusted) await openTabsOf(path, hooks);
    } catch {
      // The worktree is made; it just opens without them.
    }
  }

  async function openTabsOf(path: string, hooks: RepoHooks): Promise<void> {
    if (!sessions || hooks.tabs.length === 0) return;
    const pv = await api.profiles();
    const shell = pv.shells.some((s) => s.id === pv.defaultShell) ? pv.defaultShell : pv.shells[0]?.id;
    if (shell) openDefaultTabs(sessions, path, hooks.tabs, shell);
  }

  function startSetup(path: string, hooks: RepoHooks): void {
    if (!sessions) return;
    const tab = sessions.open(path, SETUP_PROFILE);
    sessions.rename(tab.id, t("setup.tab"));
    // The default tabs wait for setup to exit 0; after a failure the card offers them.
    const tabs = hooks.tabsTrusted && hooks.tabs.length > 0 ? () => void openTabsOf(path, hooks).catch(() => {}) : null;
    gate.track(path, tab.id, hooks.waitForSetup, tabs);
    dropCard(path);
  }

  function askTrust(path: string, repoId: string, hooks: RepoHooks, changed: boolean, kind: ScriptKind | "lists" = "setup"): void {
    const script = kind === "lists" ? null : hooks[kind];
    if (kind !== "lists" && !script) return;
    // The archive prompt is about the script alone.
    const lists = kind === "archive" ? pendingLists({ ...hooks, sharedHash: null, tabsHash: null }) : pendingLists(hooks);
    setTrusting({ path, repoId, kind, text: script?.text ?? "", hash: script?.hash ?? "", lists, changed, busy: false });
  }

  // The archive script is not trusted: show its current text, then run the removal again on Trust.
  async function askArchiveTrust(path: string): Promise<void> {
    try {
      const hooks = await api.repoHooks(path);
      const repoId = repos?.find((r) => r.worktrees.some((w) => w.path === path))?.id ?? "";
      askTrust(path, repoId, hooks, false, "archive");
    } catch (e) {
      setRemoving((r) => (r ? { ...r, error: toApiError(e).code } : r));
    }
  }

  // The card's Run setup: the script is read again first, so the trust check sees the file as it is now.
  async function runSetup(path: string, repoId: string): Promise<void> {
    try {
      const hooks = await api.repoHooks(path);
      if (!hooks.setup) return;
      if (hooks.setup.trusted) startSetup(path, hooks);
      else askTrust(path, repoId, hooks, false);
    } catch {
      // The card stays; the person can try again.
    }
  }

  // Trust the text that was shown. A refused hash means the file changed: read it again and show the new text.
  async function confirmTrust(): Promise<void> {
    if (!trusting || trusting.busy) return;
    const ask = trusting;
    setTrusting({ ...ask, busy: true });
    try {
      // The lists first, the script last, so the hooks that come back are the newest.
      let hooks: RepoHooks | null = null;
      if (ask.lists.sharedHash !== null) hooks = await api.repoHookTrust(ask.path, "shared", ask.lists.sharedHash);
      if (ask.lists.tabsHash !== null) hooks = await api.repoHookTrust(ask.path, "tabs", ask.lists.tabsHash);
      if (ask.kind !== "lists") hooks = await api.repoHookTrust(ask.path, ask.kind, ask.hash);
      setTrusting(null);
      if (ask.kind === "setup" && hooks) startSetup(ask.path, hooks);
      else if (ask.kind === "archive") void remove();
      else void setupAfterCreate(ask.path, ask.repoId, true);
    } catch (e) {
      const code = toApiError(e).code;
      if (code !== "hook_untrusted") return setTrusting({ ...ask, busy: false, error: code });
      try {
        const fresh = await api.repoHooks(ask.path);
        const script = ask.kind === "lists" ? null : fresh[ask.kind];
        const lists = ask.kind === "archive" ? ask.lists : pendingLists(fresh);
        if (!script && !hasPending(lists)) return setTrusting(null);
        setTrusting({ ...ask, text: script?.text ?? "", hash: script?.hash ?? "", lists, changed: true, busy: false, error: undefined });
      } catch (again) {
        setTrusting({ ...ask, busy: false, error: toApiError(again).code });
      }
    }
  }

  function dropCard(path: string): void {
    setCards((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== path)));
  }

  // The card of the worktree in front: a held agent beats the offers.
  function cardFor(path: string): SetupCardState | null {
    const held = gate.state(path);
    if (held) return held.phase === "running" ? { kind: "waiting" } : { kind: "failed", code: held.code, agent: held.agent, tabs: held.tabs };
    const card = cards[path];
    return card ? (card.kind === "ask" ? { kind: "ask" } : { kind: "detected", command: card.command }) : null;
  }


  function openAbout(): void {
    void api.machineName().then(setMachine, () => setMachine(""));
    void api.appVersion().then(setAbout, () => setAbout(""));
  }

  /** Help, tray and native menu "Check for updates": shows the page, and starts the check (a check already running is joined). */
  function openUpdates(): void {
    checkForUpdates({ openSettings, api });
  }

  function pickHelp(pick: HelpPick): void {
    runHelpPick(pick, { openSettings: (page) => openSettings(page), openUpdates, openAbout, toast: (key) => pushToast({ text: t(key) }), api });
  }

  // The first remote project whose host is not connected: what the palette's Reconnect acts on.
  const pendingReconnect = reconnectCandidate(remote.projects);
  function remoteProject(id: string) {
    return remote.projects.find((p) => p.id === id);
  }
  async function reconnectRemote(id: string): Promise<void> {
    const p = remoteProject(id);
    if (!p) return;
    try {
      await api.remoteConnect(p.hostId);
    } catch (e) {
      pushToast({ text: remoteError(t, toApiError(e).code, p.hostAlias) });
    }
  }
  async function disconnectRemote(id: string): Promise<void> {
    const p = remoteProject(id);
    if (p) await api.remoteDisconnect(p.hostId).catch(() => undefined);
  }
  async function removeRemote(id: string): Promise<void> {
    const p = remoteProject(id);
    if (!p) return;
    await api.remoteProjectRemove(id).catch((e: unknown) => pushToast({ text: t(`error.${toApiError(e).code}`) }));
    await remote.reload();
    void sessions?.closeWorktree(p.worktree);
  }

  // "Try it" on the feature wall opens the page or panel.
  const tryFeatureRef = useRef<(target: { kind: string; section?: string }) => void>(() => {});
  tryFeatureRef.current = (target) => {
    if (target.kind === "settings") openSettings(target.section);
    else { setSidebarOpen(true); setSideView("activity"); show("workspace"); }
  };
  useEffect(() => onTryFeature((target) => tryFeatureRef.current(target)), []);

  // Types into the tab in front when it is a live agent tab. No Enter is sent, so the person reads it first.
  async function sendToAgent(text: string): Promise<boolean> {
    const tab = target(current?.path);
    if (!tab) return false;
    await tab.client.input(text);
    return true;
  }

  // Gives a failed commit hook's output to an agent of the worktree, as its recipe says, and brings its tab to the front.
  async function fixWithAgent(id: "fixCommitFailure" | "fixPushFailure", output: string, branch = current?.branch ?? ""): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendFix(api, sessions, path, shownTab[path] ?? null, id, { branch, output });
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives the conflicts of the operation in progress to an agent of the worktree, as its recipe says.
  async function resolveConflicts(vars: Record<string, string>): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendFix(api, sessions, path, shownTab[path] ?? null, "resolveConflicts", vars);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives every failing check, each with its log when there is one, to one agent prompt.
  async function fixChecks(checks: Check[]): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendChecksFix(api, sessions, path, shownTab[path] ?? null, current.branch ?? "", checks);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives a failed check, with its log when there is one, to an agent of the worktree.
  async function fixCheck(check: Check): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendCheckFix(api, sessions, path, shownTab[path] ?? null, current.branch ?? "", check);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives the queued PR comments to the chosen agent tab; with `ack` on, resolves and replies after.
  async function sendComments(pr: { number: number; title: string; url: string }, groups: CommentGroup[], choice: SendChoice, ack: boolean): Promise<SendOutcome> {
    if (!sessions || !current) return { ok: false, summary: null };
    const path = current.path;
    const { tab, summary } = await sendCommentsFix(api, sessions, prComments, { ...pr, worktree: path, branch: current.branch ?? "" }, groups, choice, ack);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
    return { ok: tab !== null, summary };
  }

  const removingRepo = removing ? repos?.find((r) => r.worktrees.some((w) => w.path === removing.worktree.path)) : undefined;

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.profiles()).then((v) => live && v && setNameView(v), () => undefined);
    return () => void (live = false);
  }, [api]);

  return (
    <ProfilesProvider api={api}>
    <UpsellHost api={api}>
    <ShellFrame
      titlebar={<Titlebar />}
      view={view}
      onView={(next) => show(next)}
      automations={automationsSettings.showButton}
      labels={{
        workspace: t("workspace.nav.workspace"),
        docs: t("workspace.nav.docs"),
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
        {/* The docs app shows its own folder, so the crumbs go with the workspace view. */}
        {view === "workspace" && currentRepo && current && (
          <>
            <span className="ws-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="ws-crumb">{currentRepo.shortName}</span>
            <span className="ws-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="ws-crumb ws-mono">{branch}</span>
          </>
        )}
        <div className="ws-header-center">
          <HeaderSearch onOpen={openSearch} onJump={() => setJumpOpen(true)} />
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
            <Icon name="bell" size={16} />
            {statusSettings.bell && unreadCount > 0 && (
              <span className="ws-bell-count" aria-hidden="true">
                {bellCount(unreadCount)}
              </span>
            )}
          </button>
          {statusSettings.bell && bellOpen && <BellMenu rows={bellRows} now={Date.now()} onJump={(tab) => jumpTo(tab.id)} onToggleRead={(tab) => (tab.unread ? sessions?.markTabRead(tab.id) : sessions?.markTabUnread(tab.id))} onViewActivity={() => { setBellOpen(false); setSidebarOpen(true); setSideView("activity"); setActivityAsk((a) => ({ tab: "feed", seq: a.seq + 1 })); }} onClose={() => setBellOpen(false)} />}
        </div>
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
        <div id="ws-sidebar" className="ws-sidebar" hidden={!sidebarOpen}>
          <div className="ws-nav" role="group" aria-label={t("workspace.nav.label")} hidden={view !== "docs"}>
            {view === "docs" && (
              <VaultNav
                api={api}
                canOpen={docsSaved}
                onOpened={() => {
                  setDocsMounted(true);
                  setDocsKey((k) => k + 1);
                }}
              />
            )}
          </div>
          <div className="ws-side-tabs" role="group" aria-label={t("agentSessions.tabs.label")}>
            {(["worktrees", "sessions", "activity"] as const).map((v) => (
              <button key={v} type="button" className="ws-side-tab" aria-pressed={sideView === v} onClick={() => setSideView(v)}>
                {t(`agentSessions.tab.${v}`)}
              </button>
            ))}
          </div>
          {sessions && history && (
            <div className="ws-side-view" hidden={sideView !== "sessions"}>
              <SurfaceBoundary id="sidebar.sessions" surface="Sessions sidebar">
                <SessionsSidebar
                  store={history}
                  sessions={sessions}
                  current={current ? { path: current.path, repo: repos?.find((r) => r.worktrees.some((w) => w.path === current.path))?.path ?? null } : null}
                  visible={sideView === "sessions" && sidebarOpen}
                  focusSeq={sessionsAsk.focus ? sessionsAsk.seq : undefined}
                  reveal={sessionsAsk.reveal}
                  onOpened={(tab) => jumpTo(tab.id)}
                  onFocusTab={jumpTo}
                  onGoTo={(path) => {
                    const wt = all.find((w) => w.path === path);
                    if (!wt) return;
                    select(wt);
                    show("workspace");
                  }}
                />
              </SurfaceBoundary>
            </div>
          )}
          {sessions && (
            <div className="ws-side-view" hidden={sideView !== "activity"}>
              <ActivityPanel
                sessions={sessions}
                feed={feed}
                names={Object.fromEntries(all.map((w) => [w.path, { name: worktreeName(all, w.path), branch: w.branch ?? null }]))}
                ask={activityAsk}
                onJump={jumpTo}
              />
            </div>
          )}
          <div className="ws-side-view" hidden={sideView !== "worktrees"}>
          {picked.paths.size >= 2 && (
            <BulkBar
              count={picked.paths.size}
              allPinned={all.filter((w) => picked.paths.has(w.path)).every((w) => w.pinned)}
              onArchive={() => void openBulk("archive")}
              onDelete={() => void openBulk("delete")}
              onPin={() => {
                const pin = !all.filter((w) => picked.paths.has(w.path)).every((w) => w.pinned);
                void bulkEach((path) => api.worktreePin(path, pin));
              }}
              canSleep={bulkSleepable(picked.paths, sleepableMap)}
              onSleep={() => void Promise.all([...picked.paths].map((p) => sessions?.sleepWorktree(p, sessionFallback(api))))}
              onStatus={(status: WorkStatus) => void bulkEach((path) => api.worktreeDetails(path, { status }))}
              onClear={() => setPicked(clearPicked())}
              onMerge={() => {
                if (!sessions) return;
                const chosen = all.filter((w) => picked.paths.has(w.path));
                setMergeSources(
                  chosen.flatMap((w) => sessions.tabs(w.path)).map((tab) => ({ id: tab.id, title: tab.title ?? profileName(nameView, tab.profileId, t), agent: profileName(nameView, tab.profileId, t) })),
                );
              }}
              onSendPrompt={() => setComposerAsk((r) => ({ worktrees: [...picked.paths], seq: (r?.seq ?? 0) + 1 }))}
            />
          )}
          <SurfaceBoundary id="sidebar.worktrees" surface="Workspace list" titleKey="boundary.worktrees.title">
            <WorktreeList
              onOpenPr={() => openPrTab()}
              onOrder={(paths) => setOrder((o) => (o.join(",") === paths.join(",") ? o : paths))}
              picked={picked.paths}
              onPick={(wt, mods) => setPicked((sel) => pickClick(sel, wt.path, selectable, mods))}
              onSelectAll={() => setPicked(selectAll(selectable))}
              onClearPicked={() => setPicked(clearPicked())}
              onReviewBranches={(repoId) => setReview({ repoId, busy: false })}
              items={items}
              prefs={prefs}
              onPrefs={changePrefs}
              onReorder={(ids) => void sidebarCall(() => api.sidebarOrder(ids))}
              onGroupMove={(member, group, index) => void sidebarCall(() => api.groupMove(member, group, index))}
              onNewGroup={() => setGroupName({ id: null, name: "" })}
              onRenameGroup={(g: RepoGroup) => setGroupName({ id: g.id, name: g.name })}
              onRemoveGroup={(g: RepoGroup) => void sidebarCall(() => api.groupRemove(g.id))}
              onAddFolder={() => void addFolder()}
              onOpenFolder={(f) => void openFolder(f)}
              onForgetFolder={(f) => void sidebarCall(() => api.folderForget(f.id))}
              onRestore={(repoId, branch) => void sidebarCall(() => api.worktreeRestore(repoId, branch))}
              onArchive={(wt) => void archive(wt)}
              onOpenBoard={() => setBoardOpen(true)}
              onEditDetails={(wt) => setEditing({ worktree: wt, busy: false })}
              onSetParent={(wt) => setParentFor({ worktree: wt, candidates: parentCandidates(wt, repos?.find((r) => r.worktrees.some((w) => w.path === wt.path))?.worktrees ?? []) })}
              onRemoveParent={(wt) => void setDetails(wt, { parent: null }, t("lineage.error"))}
              onDeleteNested={(wt) => startRemove(wt, { nested: true })}
              onMoveStatus={(wt, status) => {
                if (status !== wt.status) void setDetails(wt, { status }, t("lineage.error"));
              }}
              onRenameBranch={(wt) => setRenaming(wt)}
              onCheckoutBranch={(wt) => setCheckingOut(wt)}
              onCopyLink={(url) => {
                void copy(url);
                pushToast({ text: t("workItem.copied") });
              }}
              selected={current?.path ?? null}
              dots={dots}
              stats={stats.all()}
              ports={livePorts}
              onOpenPort={(port) => void api.portsOpen(port.id).catch((e: unknown) => pushToast({ text: t(`error.${toApiError(e).code}`) }))}
              onCopyPort={(port) => {
                void copy(endpoint(port));
                pushToast({ text: t("ports.copied", { address: endpoint(port) }) });
              }}
              onStopPort={stopPort}
              activity={activity}
              profiles={profiles}
              prs={prMap}
              now={Date.now()}
              notice={notice}
              onSelect={(wt) => {
                setPicked(clearPicked());
                select(wt);
                show("workspace");
              }}
              onCreate={startCreate}
              pending={pending.list()}
              onCancelCreate={(id) => pending.cancel(id)}
              onRetryCreate={(id) => pending.retry(id)}
              onDismissCreate={(id) => pending.dismiss(id)}
              onPin={(wt) => void pin(wt)}
              onRemove={startRemove}
              onAddRepo={addRepo}
              onAdopt={(wt) => void adopt(wt)}
              unread={unreadMap}
              asleep={asleepMap}
              sleepable={sleepableMap}
              onSleep={(wt) => void sessions?.sleepWorktree(wt.path, sessionFallback(api))}
              onSleepNested={(wt) => void sessions?.sleepWorktree(wt.path, sessionFallback(api), all.filter((c) => c.parent === wt.path).map((c) => c.path))}
              onWake={(wt) => [wt.path, ...all.filter((c) => c.parent === wt.path).map((c) => c.path)].forEach((p) => sessions?.wakeWorktree(p))}
              onMarkUnread={(wt) => sessions?.markUnread(wt.path)}
              onMarkRead={(wt) => sessions?.markRead(wt.path)}
              openInApps={openInApps}
              onOpenIn={(path, target) => void openIn(path, target)}
              onCopy={(text) => void copy(text)}
              onNewTerminal={(wt) => void newTerminalIn(wt)}
              onRepoSettings={(repo) => openSettings("repos", repo.id)}
              onRemoveRepo={(repo) => setForgetting({ repo })}
            />
          </SurfaceBoundary>
          <RemoteGroup
            rows={remoteRows(remote.projects)}
            selected={current?.path ?? null}
            onSelect={(row) => {
              const wt = all.find((w) => w.path === row.worktree);
              if (!wt) return;
              setPicked(clearPicked());
              select(wt);
              show("workspace");
            }}
            onReconnect={(row) => void reconnectRemote(row.id)}
            onDisconnect={(row) => void disconnectRemote(row.id)}
            onRemove={(row) => void removeRemote(row.id)}
          />
          </div>
        </div>
      }
      // The docs app keeps its own status bar, so this one shows with the workspace only.
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
        hidden={view === "docs"}
      />
      }
      overlays={
        <>
      <SshAuthPrompts api={api} />
      <PeersHost api={api} />

      {creating && repos && (
        <CreateWorktreeDialog
          repos={repos}
          repoId={creating.repoId}
          name={creating.name}
          status={creating.status}
          agents={creating.agents}
          defaultAgent={creating.defaultAgent}
          namePreview={api.worktreeNamePreview}
          branches={api.worktreeBranches}
          api={api}
          initialTab={createTab.current}
          onTabChange={(tab) => (createTab.current = tab)}
          onStartPr={(repoId, pr) => {
            setCreating(null);
            void startFromPr(repoId, pr);
          }}
          onStartMr={(repoId, mr) => {
            setCreating(null);
            void startFromMr(repoId, mr);
          }}
          onCreate={(repoId, name, from, extra, request, more) => create(repoId, name, from, extra, request, more)}
          resolveIssue={(repoId, text) => api.issueResolve(repoId, text)}
          onStartIssue={(repoId, issue) => {
            setCreating(null);
            void startFromIssue(repoId, issue);
          }}
          onCancel={() => setCreating(null)}
        />
      )}
      <QuickOpenDialog
        open={quickOpen}
        api={api}
        worktree={current?.path ?? null}
        recent={recentFiles}
        onClose={() => setQuickOpen(false)}
        onOpen={(rel, { line, column, side }) => {
          if (!current) return;
          if (side) openFileSide(current.path, rel, line, column);
          else requestOpenFile({ worktree: current.path, rel, line, column });
        }}
      />
      <FloatingHost api={api} />
      <DictationHost api={api} openSettings={(section) => openSettings(section)} />
      <ComposerHost
        api={api}
        sessions={sessions}
        shownTab={current ? (shownTab[current.path] ?? null) : null}
        names={Object.fromEntries(all.map((w) => [w.path, worktreeName(all, w.path)]))}
        active={view === "workspace" && !dialogOpen}
        request={composerAsk}
      />
      <TaskEditorHost api={api} repos={repos} current={current} />
      <CaptureHost api={api} sessions={() => sessions} current={() => current?.path ?? null} shownTab={() => (current ? (shownTab[current.path] ?? null) : null)} />
      <PaletteHost
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        repos={repos}
        sessions={sessions}
        history={history}
        tasks={() => api.tasks()}
        targets={(wt) => api.targetsList(wt)}
        current={current}
        shownTab={current ? shownTab[current.path] ?? null : null}
        actions={{
          openTask,
          openTaskBoard,
          openDecompose,
          selectWorktree: (wt) => {
            select(wt);
            show("workspace");
            focusTerminal(wt.path);
          },
          showWorkspace: () => show("workspace"),
          openFile: (worktree, rel) => {
            show("workspace");
            requestOpenFile({ worktree, rel });
          },
          frontTab: (worktree, id) => {
            setFront((f) => ({ worktree, id, seq: (f?.seq ?? 0) + 1 }));
            focusTerminal(worktree);
          },
          openSettings: (section, target) => openSettings(section, undefined, target),
          newWorktree: (name) => startCreate(undefined, name),
          addRepo,
          remoteAdd: () => {
            setNotice(undefined);
            setScanRoot(undefined);
            setAddingRemote(true);
            setAdding(true);
          },
          remoteReconnect: pendingReconnect ? () => void reconnectRemote(pendingReconnect.id) : undefined,
          searchDocs: openSearch,
          toggleSidebar: () => setSidebarOpen((o) => !o),
          showDocs: () => show("docs"),
          stageAllChanges: changesReady ? () => runOnChanges((h) => h.stageAll()) : undefined,
          openSessions: () => openSessionsPanel(null),
          resumeSession: (row) => {
            if (!sessions || !row.worktree) return;
            jumpTo(confirmResume(sessions, { row, worktree: row.worktree }).id);
          },
          discardAllChanges: changesReady ? () => runOnChanges((h) => h.discardAll()) : undefined,
          runQuickCommand: (cmd) => {
            if (!sessions || !current) return;
            const path = current.path;
            const front = sessions.tabs(path).find((x) => x.id === shownTab[path]);
            show("workspace");
            void api
              .profiles()
              .then((v) => v.profiles.map((p) => p.profile.id))
              .catch(() => undefined)
              .then((profiles) =>
                runWithToast(api, cmd, { sessions, worktree: path, tab: front && front.exitCode === undefined ? front : null, profiles, focus: () => focusTerminal(path) }, t),
              );
          },
          newQuickCommand: () => openSettings("qcmd", "new"),
          captureScreen: () => startCapture(api, t),
          annotateClipboard: () => void annotateClipboard(api, t),
        }}
      />
      {trusting && (
        <TrustDialog
          repo={repos?.find((r) => r.id === trusting.repoId)?.shortName ?? ""}
          file="xdev.toml"
          kind={trusting.kind}
          text={trusting.text}
          shared={trusting.lists.shared}
          tabs={trusting.lists.tabs}
          changed={trusting.changed}
          busy={trusting.busy}
          error={trusting.error}
          onTrust={() => void confirmTrust()}
          onCancel={() => {
            const ask = trusting;
            setTrusting(null);
            // Without the lists the flow goes on: setup cards, setup itself.
            if (ask.kind === "lists") void setupAfterCreate(ask.path, ask.repoId, true);
          }}
        />
      )}
      {switching && (
        <AccountSwitchDialog provider={switching.provider} to={switching.to} tab={switching.tab} onApply={answerSwitch} onCancel={() => setSwitching(null)} />
      )}
      {quitting && <QuitDialog ask={quitting.ask} onChoose={quitting.answer} />}
      {about !== null && <AboutDialog version={about} machine={machine} buildDate={import.meta.env.VITE_BUILD_DATE} onLink={(link) => void api.helpOpen(link)} onClose={() => setAbout(null)} />}
      <ConfirmDialog
        open={confirmEndAll}
        title={t("shell.quitEndAll.title")}
        body={t("shell.quitEndAll.body")}
        confirmLabel={t("shell.quitEndAll.confirm")}
        onConfirm={() => {
          setConfirmEndAll(false);
          void api.shellQuit("end-all");
        }}
        onCancel={() => setConfirmEndAll(false)}
      />
      <CrashHost api={api} />
      {mergeSources && <MergeDialog api={api} sources={mergeSources} onClose={() => setMergeSources(null)} />}
      <ResourceHost
        api={api}
        tabs={() => (sessions?.worktrees() ?? []).flatMap((w) => sessions!.tabs(w)).map((tab) => ({ id: tab.id, title: tab.title ?? profileName(nameView, tab.profileId, t), agent: profileName(nameView, tab.profileId, t) }))}
        onStop={(id) => sessions?.close(id) ?? Promise.resolve()}
      />
      <MissionHost api={api} focusTab={jumpTo} frontTab={() => (current ? shownTab[current.path] ?? null : null)} />
      <ChartsHost
        api={api}
        host={
          sessions
            ? {
                worktree: () => current?.path ?? null,
                open: (worktree, seat, opts) => {
                  live.ensureMounted(worktree);
                  sessions.open(worktree, seat.agent, null, undefined, opts);
                },
                defer: (worktree, launch) => gate.defer(worktree, launch),
                newId: () => crypto.randomUUID(),
              }
            : null
        }
      />
      <ForeignTermsHost
        api={api}
        onOpenFolder={(path) => void addPaths([path], true)}
        onResume={(row) => {
          if (!sessions || !row.worktree) return;
          jumpTo(confirmResume(sessions, { row, worktree: row.worktree }).id);
        }}
      />
      <Toasts />
      {adding && (
        <AddProjectDialog
          api={api}
          startFolder={parentOf(repos?.[repos.length - 1]?.path ?? "")}
          onOpenFolder={() => void addRepoFolder()}
          onCloned={(repo) => void repoCloned(repo)}
          onCreated={(created) => void projectCreated(created)}
          startRemote={addingRemote}
          onCancel={() => {
            setAdding(false);
            setAddingRemote(false);
            setScanRoot(undefined);
          }}
          scanRoot={scanRoot}
          onAddRepos={(paths) => void addScanned(paths)}
          onRemoteAdded={(p) => {
            setAdding(false);
            void remote.reload().then(() => {
              select({ path: p.worktree } as WorktreeView);
              show("workspace");
            });
          }}
          onOpenSettings={() => {
            setAdding(false);
            openSettings("ssh");
          }}
        />
      )}
      {forgetting && (
        <RemoveRepoDialog
          name={forgetting.repo.shortName}
          worktrees={forgetting.repo.worktrees.length}
          tabs={forgetting.repo.worktrees.flatMap((w) => sessions?.tabs(w.path) ?? []).map((tab) => tab.title ?? tab.profileId)}
          error={forgetting.error}
          onConfirm={() => void forgetRepo(forgetting.repo)}
          onCancel={() => setForgetting(null)}
        />
      )}
      {groupName && (
        <NameDialog
          heading={t(groupName.id ? "group.rename" : "group.new")}
          label={t("group.name")}
          initial={groupName.name}
          error={groupName.error}
          onSave={(name) => void saveGroup(name)}
          onCancel={() => setGroupName(null)}
        />
      )}
      {editing && (
        <DetailsDialog
          api={api}
          repoId={repos?.find((r) => r.worktrees.some((w) => w.path === editing.worktree.path))?.id ?? ""}
          worktree={editing.worktree}
          siblings={repos?.find((r) => r.worktrees.some((w) => w.path === editing.worktree.path))?.worktrees ?? []}
          busy={editing.busy}
          error={editing.error}
          onSave={(patch) => void saveDetails(patch)}
          onCancel={() => setEditing(null)}
        />
      )}
      {boardOpen && (
        <KanbanBoard
          worktrees={repos?.find((r) => r.worktrees.some((w) => w.path === current?.path))?.worktrees ?? all}
          selected={current?.path ?? null}
          dots={dots}
          profiles={profiles}
          onSelect={(wt) => {
            setBoardOpen(false);
            select(wt);
            show("workspace");
          }}
          onMove={async (wt, status) => {
            await api.worktreeDetails(wt.path, { status });
            await load();
          }}
          onMoveError={() => pushToast({ text: t("kanban.moveError") })}
          api={api}
          repoPath={repoOf(repos, current)}
          onTaskError={() => pushToast({ id: "board-sync-failed", text: t("kanban.taskSyncError") })}
          onClose={() => setBoardOpen(false)}
          onNew={(status) => startCreate(undefined, undefined, status)}
        />
      )}
      {parentFor && (
        <ParentPickerDialog
          worktree={parentFor.worktree}
          candidates={parentFor.candidates}
          onPick={(path) => {
            const wt = parentFor.worktree;
            setParentFor(null);
            void setDetails(wt, { parent: path }, t("lineage.error"));
          }}
          onCancel={() => setParentFor(null)}
        />
      )}
      {renaming && (
        <RenameBranchDialog
          api={api}
          worktree={renaming}
          onRenamed={() => {
            setRenaming(null);
            void load();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {checkingOut && (
        <CheckoutBranchDialog
          api={api}
          worktree={checkingOut}
          onDone={() => {
            setCheckingOut(null);
            void load();
          }}
          onClose={() => setCheckingOut(null)}
        />
      )}
      {bulk && (
        <BulkRemoveDialog
          mode={bulk.mode}
          worktrees={bulk.worktrees}
          dirty={bulk.dirty}
          children={Object.fromEntries(bulk.worktrees.map((w) => [w.path, all.filter((c) => c.parent === w.path && !bulk.worktrees.some((b) => b.path === c.path)).map((c) => c.path)]))}
          busy={bulk.busy}
          result={bulk.result}
          onConfirm={(opts) => void confirmBulk(opts)}
          onCancel={() => setBulk(null)}
        />
      )}
      {review && (
        <ReviewBranchesDialog
          kept={reviewKept}
          busy={review.busy}
          error={review.error}
          onDelete={(entry) => void reviewDo(() => api.branchDelete(entry.repoId, entry.branch, true))}
          onKeep={(entry) => void reviewDo(() => api.keptKeep(entry.repoId, entry.branch))}
          onClose={() => setReview(null)}
        />
      )}
      {removing && !removing.quiet && (
        <RemoveWorktreeDialog
          worktree={removing.worktree}
          base={removingRepo?.baseRef ?? ""}
          dirty={removing.dirty}
          busy={removing.busy}
          archiving={removing.archiving}
          failed={removing.failed}
          error={removing.error}
          onConfirm={(nested) => void remove(removing.failed !== undefined, nested)}
          onDontAsk={(skip) => skip && skipDeleteConfirm()}
          onArchive={() => void archiveRemoving()}
          children={all.filter((c) => c.parent === removing.worktree.path).length}
          nestedDefault={removing.nested}
          onCancel={() => {
            removeRun.current++;
            setRemoving(null);
          }}
        />
      )}
        </>
      }
    >
        <div className="ws-stage" hidden={view !== "workspace"}>
          <div className="startup-banner-host">
            <StartupBanner api={api} />
          </div>
          <div className="ws-stage-body">
            <main className="ws-center" aria-label={t("workspace.center.label")}>
              {view === "workspace" && <RemoteBanner project={projectOf(remote.projects, current?.path ?? null)} onReconnect={(p) => void reconnectRemote(p.id)} />}
              {sessions &&
                mounted.map((path) => (
                  <SurfaceBoundary key={path} id="workspace.tabs" surface="Workspace tabs" resetKey={path} titleKey="boundary.workspace.title">
                    <WorktreeTabs
                      api={api}
                      sessions={sessions}
                      worktree={path}
                      branch={repos?.flatMap((r) => r.worktrees).find((w) => w.path === path)?.branch ?? null}
                      visible={path === current?.path}
                      onShown={(id) => setShownTab((s) => (s[path] === id ? s : { ...s, [path]: id }))}
                      onPanes={(ids) => setPanes((s) => (s[path]?.join(" ") === ids.join(" ") ? s : { ...s, [path]: ids }))}
                      reveal={reveal?.worktree === path ? { file: reveal.file, seq: reveal.seq, base: reveal.base } : undefined}
                      commit={commitAsk?.worktree === path ? { id: commitAsk.id, file: commitAsk.file, seq: commitAsk.seq } : undefined}
                      prPage={prPage?.worktree === path ? prPage.seq : undefined}
                      renderPrPage={(shown) => <ReviewPanel page api={api} worktree={path} prs={prs} comments={prComments} sessions={sessions} onSendComments={sendComments} visible={shown} onFix={(check) => fixCheck(check)} onFixAll={(checks) => fixChecks(checks)} onOpenFile={(rel) => openFile(path, rel)} />}
                      front={front?.worktree === path ? { id: front.id, seq: front.seq } : undefined}
                      focusSeq={termFocus?.worktree === path ? termFocus.seq : undefined}
                      onShowHistory={showInHistory}
                      gate={gate}
                      repo={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.path ?? null}
                      repoName={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.shortName ?? ""}
                      repoId={path.startsWith("ssh://") ? undefined : repos?.find((r) => r.worktrees.some((w) => w.path === path))?.id}
                      quickSeq={path === current?.path ? quickSeq : undefined}
                      onManageQuickCommands={() => openSettings("qcmd")}
                      onLinkSettings={() => openSettings("terminal", undefined, "terminal.linkClick")}
                      onManageAgents={() => openSettings("agents")}
                      worktrees={all.map((w) => ({ path: w.path, label: worktreeName(all, w.path) }))}
                      onJump={jumpTo}
                    />
                  </SurfaceBoundary>
                ))}
              {current && cardFor(current.path) && (
                <SetupCard
                  state={cardFor(current.path)!}
                  onSave={() => {
                    const card = cards[current.path];
                    if (card?.kind !== "detected") return;
                    void api.repoUpdate(card.repoId, { localSetup: card.command }).then(() => dropCard(current.path), () => {});
                  }}
                  onConfigure={() => {
                    dropCard(current.path);
                    openSettings("repos");
                  }}
                  onDismiss={() => {
                    dropCard(current.path);
                    void openTabsFor(current.path);
                  }}
                  onRun={() => void runSetup(current.path, cards[current.path]?.repoId ?? "")}
                  onSkip={() => {
                    dropCard(current.path);
                    void openTabsFor(current.path);
                  }}
                  onAlways={() => {
                    const repoId = cards[current.path]?.repoId;
                    if (!repoId) return;
                    void api.repoUpdate(repoId, { setupPolicy: "run" }).then(() => runSetup(current.path, repoId), () => {});
                  }}
                  onStartNow={() => gate.startNow(current.path)}
                  onOpenTabs={() => gate.openTabs(current.path)}
                  onOpenSetup={() => {
                    const id = gate.setupTab(current.path);
                    if (id) setFront((f) => ({ worktree: current.path, id, seq: (f?.seq ?? 0) + 1 }));
                  }}
                />
              )}
              {!current && repos && (
                <div className="ws-center-empty">
                  <p>{t("workspace.center.none")}</p>
                  <Button type="button" variant="primary" data-field="add-project" onClick={addRepo}>
                    {t("workspace.center.add")}
                  </Button>
                </div>
              )}
              {fixNote && (
                <p className="error-text ws-notice" role="alert">
                  {t("ship.fix.noTab")}
                </p>
              )}
            </main>
            <RightPanel open={rightOpen} tab={panelTab} changes={count} failing={failing} issuesTab={issuesGit.tab} issuesPinned={issuesPinned} onTab={(tab, focus) => { setPanelTab(tab); if (focus) focusSearch(); }}>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "files"}>
                <SurfaceBoundary id="panel.files" surface="Right sidebar: files" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <FileTree
                      key={current.path}
                      api={api}
                      worktree={current.path}
                      changes={markedChanges}
                      queue={fsWatch.queue}
                      watchHealth={fsWatch.health}
                      onOpen={(file) => openFile(current.path, file)}
                      activeFile={fileTabRel(shownTab[current.path] ?? "")}
                      onOpenTerminal={(dir) => void newTerminalIn(current, dir)}
                      onSearch={focusSearch}
                    />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "search"}>
                <SurfaceBoundary id="panel.search" surface="Right sidebar: search" resetKey={current?.path} titleKey="boundary.panel.title">
                  <SearchPanel
                    key={current?.path ?? ""}
                    api={api}
                    worktree={current?.path ?? null}
                    focusSeq={searchFocus}
                    onOpen={(rel, at) => current && requestOpenFile({ worktree: current.path, rel, line: at.line, column: at.column })}
                  />
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "changes"}>
                <SurfaceBoundary id="panel.changes" surface="Right sidebar: changes" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <WorktreeChanges
                      key={current.path}
                      api={api}
                      worktree={current}
                      sessions={sessions}
                      prs={prs}
                      onOpenFile={(file) => openFile(current.path, file)}
                      onOpenCommit={(id, file) => openCommit(current.path, id, file)}
                      onCount={(n) => setChangeCount({ worktree: current.path, count: n })}
                      onChanges={(list) => setChangeList({ worktree: current.path, list })}
                      onFixWithAgent={(output) => void fixWithAgent("fixCommitFailure", output)}
                      onFixPush={(output, branch) => void fixWithAgent("fixPushFailure", output, branch)}
                      onResolveConflicts={(vars) => void resolveConflicts(vars)}
                      onOpenGitSettings={() => openSettings("git")}
                      register={registerChanges}
                    />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "checks"}>
                <SurfaceBoundary id="panel.checks" surface="Right sidebar: checks" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <ChecksPanel key={current.path} api={api} worktree={current.path} prs={prs} comments={prComments} sessions={sessions} onSendComments={sendComments} visible={panelTab === "checks"} onFix={(check) => fixCheck(check)} onFixAll={(checks) => fixChecks(checks)} />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "pr"}>
                <SurfaceBoundary id="panel.pr" surface="Right sidebar: pull request" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <ReviewPanel key={current.path} api={api} worktree={current.path} prs={prs} comments={prComments} sessions={sessions} onSendComments={sendComments} visible={rightOpen && panelTab === "pr"} onFix={(check) => fixCheck(check)} onFixAll={(checks) => fixChecks(checks)} onOpenFile={(rel) => openFile(current.path, rel)} onOpenPage={() => live.openPrPage()} />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "issues"}>
                <SurfaceBoundary id="panel.issues" surface="Right sidebar: issues" resetKey={currentRepo?.id} titleKey="boundary.panel.title">
                  {currentRepo && !currentRepo.missing ? (
                    <IssuesPanel key={`${currentRepo.id}:${issuesGit.preset}`} initialPreset={issuesGit.preset} api={api} repoId={currentRepo.id} onStart={(d) => void startFromIssue(currentRepo.id, d.issue, d)} />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "ports"}>
                <PortsPanel api={api} store={ports} active={current?.path ?? null} visible={rightOpen && panelTab === "ports" && view === "workspace"} />
              </div>
            </RightPanel>
          </div>
        </div>

        <div className="ws-docs" hidden={view !== "docs"}>
          {docsMounted && <SurfaceBoundary id="page.docs" surface="Docs" resetKey={docsKey} titleKey="boundary.page.title"><DocsApp key={docsKey} appRequest={appRequest} board={{ repos, defaultRepo: repoOf(repos, current), sessions, current: current ? { path: current.path, branch: current.branch } : null, onStart: startBoardAgent, onOpenTab: (l) => void jumpTo(l.tabId) }} kit={{ worktree: current?.path ?? null, open: kitOpen, onOpened: kitOpened, onSendToAgent: sendToAgent, canSend: target(current?.path) !== null }} /></SurfaceBoundary>}
        </div>

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
