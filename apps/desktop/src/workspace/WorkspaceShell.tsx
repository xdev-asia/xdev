import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import pkg from "../../package.json";
import { BrandMark } from "@/components/BrandMark";
import { ProfilesProvider, profileName } from "@/agents/profileStore";
import { SETUP_PROFILE, toApiError, type Api, type ApiError, type Check, type Created, type Linked, type OpenInApp, type OpenTarget, type HookDetail, type ScriptKind, type RepoHooks, type PrView, type PtyProfile, type DetailsPatch, type KeptBranch, type RepoGroup, type FolderEntry, type WorkStatus, type SidebarItem, type SidebarPrefs, type RepoView, type WorktreeChange, type WorktreeView, type Issue, type IssueDetail, type IssuesPreset, type CreateRequest, type PrSummary, type MrSummary, type MenuAction, type SetupDecision, type BaseDrift } from "@/api";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { DocsApp, type AppRequest } from "@/DocsApp";
import type { KitTab } from "@/components/AgentKitView";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useI18n } from "@/i18n";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { CrashHost } from "@/crash/CrashHost";
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
import { fileTabId, fileTabRel, fileTabs } from "@/files/fileTabs";
import { onOpenFile, openFile as requestOpenFile, type OpenFileRequest } from "@/files/openFile";
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
import { currentCloseWindow, openRestoredFile, restoreLayout, sessionFallback, startLayoutSave, undoRestore } from "./layoutPersist";
import { copyText } from "@/terminal/terminalActions";
import { loadZoom, stepZoom, ZOOM_STEP } from "@/ui/zoom";
import { useJumpKey } from "@/palette/useJumpKey";
import { getNavigationSettings, setNavigationSettings, useNavigationSettings } from "@/settings/navigationSettings";
import { SettingsView } from "@/settings/SettingsView";
import { settingsIntent } from "@/settings/settingsIntent";
import { playStatusSound } from "@/status/sound";
import { usePresence } from "@/status/presence";
import { getStatusSettings, loadStatusSettings, useStatusSettings } from "@/status/statusSettings";
import { admits } from "./attention";
import { BellMenu, bellCount, type BellRow } from "./BellMenu";
import { ActivityPanel, type ActivityTab } from "@/activity/ActivityPanel";
import { ActivityFeed } from "@/activity/feed";
import { Icon } from "@xdev-asia/ui";
import { ChecksPanel } from "./ChecksPanel";
import { PortsItem } from "@/ports/PortsItem";
import { PortsPanel } from "@/ports/PortsPanel";
import { PortsStore } from "@/ports/portsStore";
import { IssuesPanel } from "@/issues/IssuesPanel";
import { issuesTabVisible } from "@/issues/issuesPreset";
import { CreateWorktreeDialog, type AgentChoice, type CreateExtra, type CreateTab } from "./CreateWorktreeDialog";
import { DetailsDialog } from "./DetailsDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { PendingCreates, type CreateArgs } from "./pendingCreates";
import { FileTree } from "./FileTree";
import { HeaderSearch } from "./HeaderSearch";
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
import { openFailedToast, startOrchestrationEvents } from "./orchestrationEvents";
import { AutomationsPage } from "@/automations/AutomationsPage";
import { startAutomationDispatch } from "@/automations/dispatch";
import { useAutomationsSettings } from "@/settings/automationsSettings";
import { terminalOf } from "@/terminal/terminalRegistry";
import { TrustDialog } from "./TrustDialog";
import { AccountSwitchDialog, type SwitchRow } from "./AccountSwitchDialog";
import { restartTabs, watchAccountSwitch, type PendingSwitch } from "./accountSwitchFlow";
import { QuitDialog } from "./QuitDialog";
import { AboutDialog } from "./AboutDialog";
import { checkForUpdates, HelpButton, type HelpPick, runHelpPick } from "./HelpMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { runMenuAction } from "@/shell/menuActions";
import { useShellLabels } from "@/shell/shellLabels";
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
import { WorktreeChanges, type ChangesHandlers } from "./WorktreeChanges";
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
import { runWithToast } from "@/quickCommands/runUi";
import { startQuickCommands } from "@/quickCommands/store";

const SELECTED_KEY = "xdev.workspace.selected";

// Storage can be missing or refuse access; the selection is only a convenience.
function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function storeSelected(path: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, path);
  } catch {
    // Not remembered; the next launch starts at the first worktree.
  }
}

type View = "workspace" | "docs" | "settings" | "automations";
type PanelTab = "files" | "search" | "changes" | "checks" | "issues" | "ports";
type Creating = { repoId: string; name?: string; agents: AgentChoice[]; defaultAgent: string | null };
type Editing = { worktree: WorktreeView; busy: boolean; error?: ApiError["code"] };
type SetupCardAt = { kind: "detected"; command: string; repoId: string } | { kind: "ask"; repoId: string };
type TrustAsk = { path: string; repoId: string; kind: ScriptKind | "lists"; text: string; hash: string; lists: PendingLists; changed: boolean; busy: boolean; error?: ApiError["code"] };
type BulkState = { mode: "delete" | "archive"; worktrees: WorktreeView[]; dirty: Record<string, boolean>; busy: boolean; result?: BulkResult };
type Review = { repoId: string | null; busy: boolean; error?: ApiError["code"] };
type Removing = { worktree: WorktreeView; dirty: boolean; busy: boolean; error?: ApiError["code"]; archiving?: boolean; failed?: { code: number | null; output: string };
  /** Removed without asking (Settings → General): the dialog stays hidden until something needs an answer. */
  quiet?: boolean;
  /** Opened from "Delete with nested worktrees": the nested tick starts on. */
  nested?: boolean;
};

/** The app frame: repos and worktrees on the left, the selected worktree in the middle. */
/** How often the auto sleep check runs. */
const AUTO_SLEEP_TICK_MS = 60_000;

export function WorkspaceShell(props: { api: Api }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const { askBeforeDeleteWorktree, alwaysForceDeleteWorktrees, alwaysDeleteKeptBranches } = useNavigationSettings();
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [items, setItems] = useState<SidebarItem[] | null>(null);
  const [prefs, setPrefs] = useState<SidebarPrefs>(SIDEBAR_PREFS_DEFAULTS);
  // The group name dialog: `id` null makes a new group.
  // The multi-selection, the bulk delete or archive dialog, and the branch review.
  const [picked, setPicked] = useState<Selection>(clearPicked);
  const [bulk, setBulk] = useState<BulkState | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [groupName, setGroupName] = useState<{ id: string | null; name: string; error?: ApiError["code"] } | null>(null);
  const [selected, setSelected] = useState<string | null>(() => readSelected());
  const [view, setView] = useState<View>("workspace");
  // The docs app mounts on first visit and then stays, so its editor state survives a switch.
  const [docsMounted, setDocsMounted] = useState(false);
  // A request for the Agent kit to open a tab; a new `seq` is a new request.
  const [kitOpen, setKitOpen] = useState<{ tab: KitTab; seq: number } | null>(null);
  // A request for the docs view to show one of its apps (the usage popover asks for Accounts).
  const [appRequest, setAppRequest] = useState<AppRequest | null>(null);
  // The tab in front of each worktree, which is where a prompt from the Agent kit is typed.
  const [shownTab, setShownTab] = useState<Record<string, string | null>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The right panel (Files / Changes / Checks); hidden, not unmounted, so its state stays.
  const [rightOpen, setRightOpen] = useState(true);
  // The mounted changes panel's bulk actions, for the palette.
  const changesHandlers = useRef<ChangesHandlers | null>(null);
  const [changesReady, setChangesReady] = useState(false);
  const registerChanges = useCallback((h: ChangesHandlers | null) => {
    changesHandlers.current = h;
    setChangesReady(h !== null);
  }, []);
  const runOnChanges = (run: (h: ChangesHandlers) => void) => {
    setSidebarOpen(true);
    setPanelTab("changes");
    if (changesHandlers.current) run(changesHandlers.current);
  };
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
  // "On quit: Ask": the question shown while the window waits to close.
  const [quitting, setQuitting] = useState<{ ask: QuitAsk; answer(choice: QuitChoice): void } | null>(null);
  // The About dialog (its version, once known) and the "quit and end terminals" confirmation.
  const [about, setAbout] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [confirmEndAll, setConfirmEndAll] = useState(false);
  const [gate] = useState(() => new SetupGate());
  // Worktrees whose setup flow already ran (made here, or run for a worker); it runs once each.
  const setupRan = useRef(new Set<string>());
  // Which remove is current; a Cancel during the archive run bumps it so the late result is dropped.
  const removeRun = useRef(0);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [renaming, setRenaming] = useState<WorktreeView | null>(null);
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
  // How many files the Changes panel last listed, for the worktree it listed them for.
  const [changeCount, setChangeCount] = useState<{ worktree: string; count: number } | null>(null);
  // The files the Changes panel last listed; the Files tree marks them.
  const [changeList, setChangeList] = useState<{ worktree: string; list: WorktreeChange[] } | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("files");
  // Settings → Git: where the Issues panel opens, and whether its tab shows. The shortcut pins the tab for the session.
  const [issuesGit, setIssuesGit] = useState<{ preset: IssuesPreset; tab: boolean }>({ preset: "all", tab: true });
  const [issuesPinned, setIssuesPinned] = useState(false);
  // The window has the person: focused and not minimised. Only then is a pane on screen seen.
  const [focused, setFocused] = useState(windowFocused);
  // The terminal panes on screen in each worktree, as its tab strip reports them.
  const [panes, setPanes] = useState<Record<string, string[]>>({});
  const [bellOpen, setBellOpen] = useState(false);
  const statusSettings = useStatusSettings();
  const automationsSettings = useAutomationsSettings();
  // What the long-lived listeners read: the latest render's list, words and jump, much like a ref.
  const [live] = useState(() => ({ repos: null as RepoView[] | null, t, jump: (_id: string): boolean => false, openShortcuts: (_action?: string) => {}, openFileTab: (_req: OpenFileRequest) => {}, deleteKey: () => {}, notifier: null as Notifier | null, selected: null as string | null, reload: () => {}, ensureMounted: (_w: string) => {}, prepareSetup: async (_w: string) => {}, cliOpen: (_w: string, _p: string, _prompt: string | null) => {}, cliPoke: () => {}, automationSetup: async (_w: string, _r: string, _d: SetupDecision) => {} }));

  // The line counts of the listed worktrees. The object holds nothing live until the effect
  // below attaches it, so load() can hand it the list before or after that.
  const [stats] = useState(() => new WorktreeStats());
  // Bumped when a vault opens from the sidebar, so the docs app boots again on the new folder.
  const [docsKey, setDocsKey] = useState(0);
  // Pull requests and checks of every worktree, shared by the ship bar and the panels.
  const [prs] = useState(() => new PrStore(api));
  const [prComments] = useState(() => new PrCommentStore(api));
  // The listening ports of every worktree; it polls only while the Ports tab is in front.
  const [ports] = useState(() => new PortsStore(api));
  // The jump palette, and the settings section it asked for; a new `seq` is a new request.
  const [jumpOpen, setJumpOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  // A new value asks the search tab for the keyboard.
  const [searchFocus, setSearchFocus] = useState(0);
  // Asks the front terminal of a worktree to take keyboard focus, as the palette closes.
  const [termFocus, setTermFocus] = useState<{ worktree: string; seq: number } | null>(null);
  const focusTerminal = (worktree: string) => setTermFocus((f) => ({ worktree, seq: (f?.seq ?? 0) + 1 }));
  // The repo Remove from xDev asks about, and why the last try failed.
  const [forgetting, setForgetting] = useState<{ repo: RepoView; error?: ApiError["code"] } | null>(null);
  // The Add project dialog (Open folder… or Clone from URL).
  const [adding, setAdding] = useState(false);
  // The folder the Add project dialog opens scanning, when a picked folder held no repo itself.
  const [scanRoot, setScanRoot] = useState<string>();
  const [openInApps, setOpenInApps] = useState<OpenInApp[]>([]);
  // A new value asks the front pane to open its quick commands popover.
  const [quickSeq, setQuickSeq] = useState(0);
  const [settingsAt, setSettingsAt] = useState<{ section?: string; arg?: string; target?: string; seq: number }>({ seq: 0 });
  // Not over a worktree dialog: it is modal, and the palette would stack on top of it.
  const dialogOpen = creating !== null || removing !== null || adding || groupName !== null || editing !== null || renaming !== null || bulk !== null || review !== null;
  useJumpKey(useCallback(() => setJumpOpen((o) => (dialogOpen ? false : !o)), [dialogOpen]));
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
        const kept = new Set(list.flatMap((r) => r.worktrees.map((w) => w.path)));
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

  // Layout restore: once per run, after the registry is known and before the saver starts (a saver that
  // ran first would replace the stored layout with an empty one). Nothing runs without a worktree.
  const restoreStarted = useRef(false);
  const saver = useRef<ReturnType<typeof startLayoutSave> | null>(null);
  const flushOnClose = useRef(() => saver.current?.flush());
  // The layout restore has ended (or there was nothing to restore): automation runs may start, and find the tabs they reuse.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (sessions && repos && repos.length === 0) setRestored(true);
    if (!sessions || !repos || repos.length === 0 || restoreStarted.current) return;
    restoreStarted.current = true;
    const known = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)));
    // A missing repo lists no worktrees though they may still exist: then the unknown ones stay saved.
    const incomplete = repos.some((r) => r.missing);
    void restoreLayout(api, sessions, (w) => known.has(w), openRestoredFile(api, fileTabs), () => incomplete, (key) => t(key)).then((got) => {
      // The store was replaced (dev double mount) while the restore ran: this run is over.
      if (!restoreStarted.current) return;
      saver.current = startLayoutSave(api, sessions);
      if (typeof window !== "undefined") window.addEventListener("beforeunload", flushOnClose.current);
      if (!got || got.report.opened.length === 0) return;
      const { resumed, fresh, opened } = got.report;
      pushToast({
        text: live.t("layout.restored", { resumed, fresh }),
        actions: [{ label: live.t("layout.undo"), run: () => void undoRestore(sessions, opened) }],
      });
    }).finally(() => {
      if (restoreStarted.current) setRestored(true);
    });
  }, [sessions, repos]);
  // The close guard, set up once at mount: it looks the saver and the tabs up when a close fires, so it
  // also works on the welcome screen, with no repos, and while the layout restore still runs.
  const sessionsNow = useRef<Sessions | null>(null);
  sessionsNow.current = sessions;
  useEffect(() => {
    let stopped = false;
    let stop = () => {};
    void currentCloseWindow().then((win) => {
      if (stopped) return;
      stop = installCloseGuard(
        win,
        () => saver.current,
        () =>
          guardClose(api, { title: live.t("shell.tray.tooltip"), body: live.t("shell.tray.notice") }, () =>
            askQuit(
              api,
              () => getTerminalSettings().onQuit,
              () => sessionsNow.current?.worktrees().flatMap((w) => sessionsNow.current?.tabs(w) ?? []) ?? [],
              (ask) =>
                new Promise<QuitChoice>((resolve) =>
                  setQuitting({
                    ask,
                    answer: (choice) => {
                      setQuitting(null);
                      resolve(choice);
                    },
                  }),
                ),
            ),
          ),
      );
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [api]);
  useEffect(() => {
    const close = flushOnClose.current;
    return () => {
      restoreStarted.current = false;
      saver.current?.stop();
      saver.current = null;
      if (typeof window !== "undefined") window.removeEventListener("beforeunload", close);
    };
  }, [sessions]);

  // The active account changed (Accounts, the usage popover, a removal): the running agent tabs that
  // follow it are restarted, kept or asked about by the `agents.accountSwitch` setting.
  // Switches queue: a second one while the dialog is open waits its turn instead of replacing the first.
  const [switches, setSwitching] = useState<PendingSwitch[]>([]);
  const switching = switches[0] ?? null;
  useEffect(() => {
    if (!sessions) return;
    const watcher = watchAccountSwitch({
      api,
      sessions,
      notify: (key, vars) => pushToast({ text: live.t(key, vars) }),
      ask: (p) => setSwitching((q) => [...q, p]),
    });
    return () => watcher.stop();
  }, [api, sessions]);
  async function answerSwitch(pending: PendingSwitch, restart: string[] | null, remember: boolean): Promise<void> {
    setSwitching((q) => q.filter((p) => p !== pending));
    if (remember) {
      // "Don't ask again" stores what was chosen; a failed write only means it asks again.
      const current = await api.agentsSettings().catch(() => null);
      if (current) await api.agentsSettingsPut({ ...current, accountSwitch: restart ? "restart" : "keep" }).catch(() => {});
    }
    if (restart && sessions) await restartTabs({ api, sessions, notify: (key, vars) => pushToast({ text: live.t(key, vars) }) }, pending, restart);
  }

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

  // The cards' ports chip reads the same store as the Ports panel: one scanner, one poll.
  useSyncExternalStore(useCallback((fn: () => void) => ports.subscribe(fn), [ports]), ports.snapshot, ports.snapshot);
  const cardPorts = prefs.card.ports && !prefs.compactCards;
  useEffect(() => {
    ports.want("cards", cardPorts);
    return () => ports.want("cards", false);
  }, [ports, cardPorts]);
  // A hidden window polls the ports every 30 s instead of every 5 s.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => ports.setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [ports]);
  const livePorts = cardPorts ? livePortsByWorktree(ports.state().scan) : {};
  async function stopPort(_wt: WorktreeView, port: LivePort): Promise<void> {
    await stopFromCard(ports, port, (key, vars) => pushToast({ text: t(key, vars) }));
  }
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

  const allPaths = JSON.stringify(all.map((w) => w.path));
  useEffect(() => {
    ports.setWorktrees(JSON.parse(allPaths) as string[]);
  }, [ports, allPaths]);
  useEffect(() => {
    const off = ports.watch();
    return () => {
      void off.then((fn) => fn());
      ports.dispose();
    };
  }, [ports]);

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

  // Focus and visibility decide what is seen; a minimised or background window sees nothing.
  useEffect(() => {
    const update = () => setFocused(windowFocused());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // The panes the person looks at: the selected worktree's front pair, with the workspace up, the window
  // focused and some trusted input in the last 180 s.
  const present = usePresence();
  const seenKey = focused && present && view === "workspace" && current ? (panes[current.path] ?? []).join(" ") : "";
  useEffect(() => {
    sessions?.setSeen(seenKey ? seenKey.split(" ") : []);
  }, [sessions, seenKey]);

  // Settings stores its own switches; they are read again on leaving it, on coming back to the window
  // and before every notification, so a change there applies without a restart.
  useEffect(() => {
    void loadStatusSettings(api);
  }, [api, view, focused]);

  // With hooks off the marker drops every hook event, so open panes go back to timing.
  useEffect(() => {
    sessions?.setHooks(statusSettings.hooks);
  }, [sessions, statusSettings.hooks]);

  // The Activity feed records every status change of the agent tabs.
  useEffect(() => {
    if (!sessions) return;
    return feed.follow(sessions);
  }, [feed, sessions]);

  // Whether an agent works, for the keep-awake mode "while agents work".
  useEffect(() => {
    if (!sessions) return;
    return startKeepAwakeReport(api, sessions);
  }, [api, sessions]);

  // The time agents work, for the counters on Settings → Stats & Usage.
  useEffect(() => {
    if (!sessions) return;
    return startBusyReport(api, sessions);
  }, [api, sessions]);

  // A pane nobody looks at that wants the person: OS notification, sound, and the jump back on a click.
  useEffect(() => {
    if (!sessions) return;
    const notifier = createNotifier({
      api,
      settings: () => loadStatusSettings(api),
      play: (settings, now) => playStatusSound(api, settings, now),
      now: () => Date.now(),
      t: (key, vars) => live.t(key, vars),
    });
    live.notifier = notifier;
    const offAttention = sessions.onAttention((tab, status, detail) => void announce(notifier, tab, status, detail));
    let closed = false;
    let offClick: (() => void) | null = null;
    api
      .onStatusNotificationClick((id) => {
        notifier.cancelFocusJump();
        live.jump(id);
      })
      .then((off) => {
        if (closed) off();
        else offClick = off;
      })
      .catch(() => {});
    // A click on a toast does not always reach the app (on Windows only while it is on screen), but
    // the window does get the focus: one soon after a notification goes to its pane, unless the
    // person clicked in the app first.
    const onFocus = () => {
      const id = notifier.takeFocusJump(Date.now());
      if (id) live.jump(id);
    };
    const onPointer = () => notifier.cancelFocusJump();
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      closed = true;
      offClick?.();
      offAttention();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onPointer, true);
      notifier.dispose();
      if (live.notifier === notifier) live.notifier = null;
    };
  }, [api, sessions]);

  // The bell lists the unread tabs and the taskbar badge counts the unread worktrees, both only for the
  // events that are switched on (and none with the master switch off).
  const counted = (tab: Tab) => admits(tab.unreadReason, statusSettings);
  const unreadTabs = (sessions?.unreadTabs() ?? []).filter(counted);
  const unreadCount = statusSettings.enabled ? (sessions?.unreadWorktrees(counted).length ?? 0) : 0;
  useEffect(() => {
    live.notifier?.badge(unreadCount);
  }, [sessions, unreadCount, statusSettings.badge]);
  // A notified tab that is read has its OS notification taken down.
  const unreadKey = unreadTabs.map((tab) => tab.id).join(",");
  useEffect(() => {
    live.notifier?.unread(unreadKey ? unreadKey.split(",") : []);
  }, [sessions, unreadKey]);
  const bellRows: BellRow[] = unreadTabs.map((tab) => ({
    tab,
    worktree: worktreeName(all, tab.worktree),
    name: tab.title ?? profileName(null, tab.profileId, t),
  }));

  // The notification text: the worktree, then the tab by its profile's name or the one given by
  // hand. Never the terminal's own title, which can carry what was typed.
  async function announce(notifier: Notifier, tab: Tab, status: Attention, detail: HookDetail | null): Promise<void> {
    const worktree = worktreeName(live.repos?.flatMap((r) => r.worktrees) ?? [], tab.worktree);
    const name = tab.renamed && tab.title ? tab.title : profileName(await api.profiles().catch(() => null), tab.profileId, live.t);
    await notifier.attention(tab, status, { worktree, tab: name }, detail);
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
  live.deleteKey = deleteKey;
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
  live.cliOpen = (worktree, profile, prompt) => void openDefaultAgent(worktree, profile || undefined, prompt ?? undefined);
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
    const stopEvents = startCliEvents(api, { reload: () => live.reload(), openTab: (w, p, prompt) => live.cliOpen(w, p, prompt), t: (key, vars) => live.t(key, vars) });
    // Worker tabs the backend asks for, closes and reads (orchestration).
    const stopOrchestration = startOrchestrationEvents(api, {
      sessions,
      gate,
      send: (worktree, id, text, timeoutMs) => sendToOpenedTab(sessions, worktree, id, text, { timeoutMs }),
      terminal: terminalOf,
      ensureMounted: (w) => live.ensureMounted(w),
      prepareSetup: (w) => live.prepareSetup(w),
      failed: (open, stage) => void openFailedToast(open, stage, (key, vars) => live.t(key, vars)),
    });
    return () => {
      reporter.stop();
      stopEvents();
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

  function toggleBell(): void {
    const next = !bellOpen;
    setBellOpen(next);
    if (!next) return;
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
      document.querySelector<HTMLElement>(".ws-bell-pop [role=menuitem], .ws-bell-pop")?.focus();
    }, 0);
  }

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
  // A panel key shows that tab of the right panel; pressed again on the tab in front, it closes the panel.
  function panelKey(tab: PanelTab): void {
    show("workspace");
    if (rightOpen && panelTab === tab) {
      setRightOpen(false);
      return;
    }
    setRightOpen(true);
    setPanelTab(tab);
    if (tab === "issues") setIssuesPinned(true);
  }
  // Read on start and again when the person comes back from Settings.
  useEffect(() => {
    if (view === "settings") return;
    api.gitSettings().then(
      (git) => setIssuesGit({ preset: git.issuesDefaultView, tab: git.showIssuesTab }),
      () => undefined,
    );
  }, [api, view]);
  useEffect(() => startQuickCommands(api), [api]);
  useShellLabels(api);
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
      setPanelTab("search");
      setSearchFocus((n) => n + 1);
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
  async function newTerminalIn(wt: WorktreeView): Promise<void> {
    if (!sessions) return;
    try {
      const pv = await api.profiles();
      const shell = pv.shells.some((s) => s.id === pv.defaultShell) ? pv.defaultShell : pv.shells[0]?.id;
      if (!shell) return;
      sessions.open(wt.path, shell);
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

  function keptNotice(kept: KeptBranch[]): void {
    const out = keptOutcome(kept);
    if (!out) return;
    if (out.kind === "one") {
      const { repoId, branch } = out.kept;
      return void pushToast({
        text: t("review.keptOne.title"),
        actions: [{ label: t("review.keptOne.delete"), run: () => void api.branchDelete(repoId, branch, true).then(() => load(), (e) => setNotice(toApiError(e).code)) }],
      });
    }
    pushToast({ text: t("review.notice", { count: out.count }), actions: [{ label: t("review.notice.button"), run: () => setReview({ repoId: null, busy: false }) }] });
  }

  // "Don't ask again" on the delete dialog: the choice is saved in Settings → General.
  function skipDeleteConfirm(): void {
    void api
      .navigationSettingsPut({ ...getNavigationSettings(), askBeforeDeleteWorktree: false })
      .then((stored) => {
        setNavigationSettings(stored);
        pushToast({ text: t("workspace.remove.skipToast"), actions: [{ label: t("workspace.remove.openSettings"), run: () => openSettings("general") }] });
      })
      .catch((e) => setNotice(toApiError(e).code));
  }

  async function openBulk(mode: "delete" | "archive"): Promise<void> {
    const wts = all.filter((w) => picked.paths.has(w.path) && !w.primary);
    if (wts.length === 0) return;
    const dirty: Record<string, boolean> = {};
    await Promise.all(wts.map(async (w) => void (dirty[w.path] = ((await api.worktreeChanges(w.path).catch(() => [])) as unknown[]).length > 0)));
    setBulk({ mode, worktrees: wts, dirty, busy: false });
  }

  async function confirmBulk(opts: { anyway: boolean; nested: boolean }): Promise<void> {
    if (!bulk || bulk.busy) return;
    const b = bulk;
    setBulk({ ...b, busy: true });
    const chosen = b.worktrees.map((w) => w.path);
    // Nested children go first, so a parent never leaves them half-linked.
    const kids = opts.nested ? all.filter((c) => c.parent && chosen.includes(c.parent) && !chosen.includes(c.path)).map((c) => c.path) : [];
    const list = [...kids, ...chosen];
    const targets = opts.anyway ? list : list.filter((p) => b.dirty[p] !== true);
    const skipped = list.filter((p) => !targets.includes(p));
    const bulkArgs = removeArgs(opts.anyway, { alwaysForce: alwaysForceDeleteWorktrees, alwaysDeleteKept: alwaysDeleteKeptBranches });
    const op = (p: string) => (b.mode === "archive" ? api.worktreeArchive(p, opts.anyway, true) : api.worktreeRemove(p, bulkArgs.force, true, bulkArgs.deleteUnmerged));
    const result = await runBulk(targets, op, async (p) => void (await sessions?.closeWorktree(p)));
    for (const path of skipped) result.failed.push({ path, error: { code: "worktree_dirty" } });
    for (const path of result.ok) sessions?.dropCarried(path);
    setBulk({ ...b, busy: false, result });
    setPicked(clearPicked());
    keptNotice(result.kept);
    await load();
  }

  async function bulkEach(run: (path: string) => Promise<unknown>): Promise<void> {
    setNotice(undefined);
    try {
      for (const path of picked.paths) await run(path);
    } catch (e) {
      setNotice(toApiError(e).code);
    }
    await load();
  }

  function deleteKey(): void {
    if (dialogOpen || view !== "workspace") return;
    const chosen = [...picked.paths];
    if (chosen.length >= 2) return void openBulk("delete");
    const wt = chosen.length === 1 ? all.find((w) => w.path === chosen[0]) : current;
    if (wt && !wt.primary) startRemove(wt);
  }

  // Delete of one worktree (row menu or the delete shortcut). With Settings → General → "Ask before
  // deleting a worktree" off it runs at once with the dialog's defaults (keep the branch, no force,
  // nested worktrees kept); the dialog still shows when the worktree is dirty, the archive script
  // fails or needs trust, or the removal errors. Bulk delete keeps its own dialog.
  function startRemove(wt: WorktreeView, opts: { nested?: boolean } = {}): void {
    const next: Removing = { worktree: wt, dirty: false, busy: false, nested: opts.nested };
    if (askBeforeDeleteWorktree || opts.nested) return setRemoving(next);
    const quiet: Removing = { ...next, quiet: true };
    setRemoving(quiet);
    void remove(false, false, quiet);
  }

  const reviewKept = review ? Object.entries(keptByRepo(items ?? [])).flatMap(([id, list]) => (review.repoId === null || review.repoId === id ? list : [])) : [];

  async function reviewDo(run: () => Promise<unknown>): Promise<void> {
    setReview((r) => (r ? { ...r, busy: true, error: undefined } : r));
    try {
      await run();
      await load();
      setReview((r) => (r ? { ...r, busy: false } : r));
    } catch (e) {
      setReview((r) => (r ? { ...r, busy: false, error: toApiError(e).code } : r));
    }
  }

  async function archiveRemoving(): Promise<void> {
    if (!removing || removing.busy) return;
    const { worktree, dirty } = removing;
    setRemoving({ worktree, dirty, busy: true });
    try {
      await sessions?.closeWorktree(worktree.path);
      sessions?.dropCarried(worktree.path);
      await api.worktreeArchive(worktree.path, dirty, true);
      setRemoving(null);
      await load();
    } catch (e) {
      const code = toApiError(e).code;
      setRemoving({ worktree, dirty: dirty || code === "worktree_dirty", busy: false, error: code === "worktree_dirty" ? undefined : code });
    }
  }

  async function archive(wt: WorktreeView): Promise<void> {
    await sessions?.closeWorktree(wt.path);
    const ok = await sidebarCall(() => api.worktreeArchive(wt.path, false, true));
    if (ok) sessions?.dropCarried(wt.path);
  }

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

  // The docs app marks its status line while the open doc differs from disk; DocsApp.tsx stays as is.
  function docsSaved(): boolean {
    return typeof document === "undefined" || !document.querySelector(".ws-docs .doc-status[data-dirty]");
  }

  function startCreate(repoId?: string, name?: string): void {
    const usable = repos?.filter((r) => !r.missing) ?? [];
    const id = repoId ?? (currentRepo && !currentRepo.missing ? currentRepo.id : usable[0]?.id);
    if (!id) return;
    setCreating({ repoId: id, name, agents: [], defaultAgent: null });
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
  async function openDefaultAgent(path: string, pick?: string | null, prompt?: string): Promise<void> {
    if (!sessions || pick === null) return;
    try {
      const view = await api.profiles();
      const usable = (id: string) => view.profiles.some((p) => p.profile.id === id && p.profile.enabled && p.installed);
      if (pick !== undefined && !usable(pick)) {
        const name = view.profiles.find((p) => p.profile.id === pick)?.profile.name ?? pick;
        pushToast({
          text: t("workspace.agentUnusable", { name }),
          actions: [{ label: t("workspace.agentPicker.manage"), run: () => openSettings("agents") }],
        });
        return;
      }
      const agent = pick ?? view.resolvedDefault;
      const shell = view.shells.some((s) => s.id === view.defaultShell) ? view.defaultShell : view.shells[0]?.id;
      const id = agent ?? shell;
      if (!id) return;
      // The prompt goes with the agent tab: on its command line, or typed once it started.
      const launch = (): void => void sessions.open(path, id, null, undefined, agent && prompt ? { prompt } : {});
      // With the repo set to wait, the tab opens when the setup tab has exited.
      if (!gate.defer(path, launch)) launch();
    } catch {
      // The worktree is made; it just opens empty.
    }
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

  // Terminals go first so nothing holds the folder, then the folder; uncommitted work needs a
  // second, forced confirm.
  // The archive script runs first (up to 120 s, Cancel stays usable); a failure asks, an untrusted
  // shared script opens the trust prompt, and no script goes straight on.
  async function remove(skipArchive = false, nested = false, target: Removing | null = removing): Promise<void> {
    if (!target || target.busy) return;
    const { worktree, dirty, quiet } = target;
    const run = ++removeRun.current;
    try {
      if (!skipArchive) {
        setRemoving({ worktree, dirty, busy: true, archiving: true, quiet });
        const ran = await api.worktreeArchiveRun(worktree.path);
        if (run !== removeRun.current) return;
        if (ran.ran && ran.code !== 0) return setRemoving({ worktree, dirty, busy: false, failed: { code: ran.code, output: ran.output } });
      }
      setRemoving({ worktree, dirty, busy: true, quiet });
      await sessions?.closeWorktree(worktree.path);
      sessions?.dropCarried(worktree.path);
      if (nested) {
        for (const child of all.filter((c) => c.parent === worktree.path)) {
          await sessions?.closeWorktree(child.path);
          sessions?.dropCarried(child.path);
          await api.worktreeRemove(child.path, alwaysForceDeleteWorktrees, true, alwaysDeleteKeptBranches);
        }
      }
      const args = removeArgs(dirty, { alwaysForce: alwaysForceDeleteWorktrees, alwaysDeleteKept: alwaysDeleteKeptBranches });
      const done = await api.worktreeRemove(worktree.path, args.force, true, args.deleteUnmerged);
      keptNotice(done.kept ? [done.kept] : []);
      setRemoving(null);
      await load();
    } catch (e) {
      if (run !== removeRun.current) return;
      const code = toApiError(e).code;
      if (code === "hook_untrusted") {
        setRemoving({ worktree, dirty, busy: false });
        return void askArchiveTrust(worktree.path);
      }
      const nowDirty = dirty || code === "worktree_dirty";
      setRemoving({ worktree, dirty: nowDirty, busy: false, error: code === "worktree_dirty" ? undefined : code });
    }
  }

  function openAbout(): void {
    void api.appVersion().then(setAbout, () => setAbout(""));
  }

  /** Help, tray and native menu "Check for updates": shows the page, and starts the check (a check already running is joined). */
  function openUpdates(): void {
    checkForUpdates({ openSettings, api });
  }

  function pickHelp(pick: HelpPick): void {
    runHelpPick(pick, { openSettings: (page) => openSettings(page), openUpdates, openAbout, api });
  }

  // `toggle`: asking for the place Settings already shows closes it instead.
  function openSettings(section?: string, arg?: string, target?: string, toggle = false): void {
    const next = settingsIntent(settingsAt, view === "settings", { section, arg, target }, toggle);
    if (next.close) {
      show("workspace");
      return;
    }
    setSettingsAt(next.at);
    show("settings");
  }

  function show(next: View): void {
    setView(next);
    if (next === "docs") setDocsMounted(true);
  }

  // Usage details & history live on the Stats & Usage settings page; the Kit app keeps its own tab.
  function openUsage(): void {
    openSettings("usage");
  }

  function openTask(id: string): void {
    setAppRequest((r) => ({ app: "tasks", task: id, seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  function openAccounts(): void {
    setAppRequest((r) => ({ app: "accounts", seq: (r?.seq ?? 0) + 1 }));
    show("docs");
  }

  // The Kit shows a request once, then hands it back; a later mount of a host finds none waiting.
  function kitOpened(seq: number): void {
    setKitOpen((k) => (k && k.seq === seq ? null : k));
  }

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

  // The docs app has the only search for now; it shows after this render, so its box is looked up then.
  function openSearch(): void {
    show("docs");
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
      const box = document.querySelector<HTMLInputElement>(".ws-docs .search-input");
      box?.focus();
      box?.select();
    }, 0);
  }

  const removingRepo = removing ? repos?.find((r) => r.worktrees.some((w) => w.path === removing.worktree.path)) : undefined;

  return (
    <ProfilesProvider api={api}>
    <div className="ws-shell">
      <header className="ws-header">
        <button
          type="button"
          className="ws-icon-btn"
          aria-label={t("workspace.toggleSidebar")}
          title={t("workspace.toggleSidebar")}
          aria-expanded={sidebarOpen}
          aria-controls="ws-sidebar"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <NavButtons canBack={nav.canBack} canForward={nav.canForward} onBack={nav.back} onForward={nav.forward} />
        <BrandMark className="ws-logo" size={18} />
        <span className="ws-brand">xDev</span>
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
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
            {statusSettings.bell && unreadCount > 0 && (
              <span className="ws-bell-count" aria-hidden="true">
                {bellCount(unreadCount)}
              </span>
            )}
          </button>
          {statusSettings.bell && bellOpen && <BellMenu rows={bellRows} now={Date.now()} onJump={(tab) => jumpTo(tab.id)} onToggleRead={(tab) => (tab.unread ? sessions?.markTabRead(tab.id) : sessions?.markTabUnread(tab.id))} onViewActivity={() => { setBellOpen(false); setSidebarOpen(true); setSideView("activity"); setActivityAsk((a) => ({ tab: "feed", seq: a.seq + 1 })); }} onClose={() => setBellOpen(false)} />}
        </div>
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
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
        <LanguageSwitch />
      </header>

      <div className="ws-body">
        <aside id="ws-sidebar" className="ws-sidebar" aria-label={t("workspace.sidebar")} hidden={!sidebarOpen}>
          <nav className="ws-nav" aria-label={t("workspace.nav.label")}>
            <button
              type="button"
              className="ws-nav-item"
              aria-current={view === "workspace" ? "page" : undefined}
              onClick={() => show("workspace")}
            >
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 17l6-6-6-6M12 19h8" />
              </svg>
              <span>{t("workspace.nav.workspace")}</span>
            </button>
            {automationsSettings.showButton && (
              <button
                type="button"
                className="ws-nav-item"
                data-nav="automations"
                aria-current={view === "automations" ? "page" : undefined}
                onClick={() => show("automations")}
              >
                <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                <span>{t("workspace.nav.automations")}</span>
              </button>
            )}
            <button
              type="button"
              className="ws-nav-item"
              aria-current={view === "docs" ? "page" : undefined}
              onClick={() => show("docs")}
            >
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6" />
              </svg>
              <span>{t("workspace.nav.docs")}</span>
            </button>
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
          </nav>
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
            />
          )}
          <SurfaceBoundary id="sidebar.worktrees" surface="Workspace list" titleKey="boundary.worktrees.title">
            <WorktreeList
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
          </div>
        </aside>

        <div className="ws-stage" hidden={view !== "workspace"}>
          <div className="startup-banner-host">
            <StartupBanner api={api} />
          </div>
          <div className="ws-stage-body">
            <main className="ws-center" aria-label={t("workspace.center.label")}>
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
                      reveal={reveal?.worktree === path ? { file: reveal.file, seq: reveal.seq } : undefined}
                      commit={commitAsk?.worktree === path ? { id: commitAsk.id, file: commitAsk.file, seq: commitAsk.seq } : undefined}
                      front={front?.worktree === path ? { id: front.id, seq: front.seq } : undefined}
                      focusSeq={termFocus?.worktree === path ? termFocus.seq : undefined}
                      onShowHistory={showInHistory}
                      gate={gate}
                      repo={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.path ?? null}
                      repoName={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.shortName ?? ""}
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
                </div>
              )}
              {fixNote && (
                <p className="error-text ws-notice" role="alert">
                  {t("ship.fix.noTab")}
                </p>
              )}
            </main>
            <aside className="ws-panel" hidden={!rightOpen} aria-label={t("workspace.panel.label")}>
              <div className="ws-panel-tabs" role="tablist" aria-label={t("workspace.panel.label")}>
                <button
                  type="button"
                  role="tab"
                  className="ws-panel-tab"
                  aria-selected={panelTab === "files"}
                  aria-label={t("workspace.panel.files")}
                  title={t("workspace.panel.files")}
                  onClick={() => setPanelTab("files")}
                >
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </button>
                <button
                  type="button"
                  role="tab"
                  className="ws-panel-tab"
                  aria-selected={panelTab === "search"}
                  aria-label={t("search.files.tab")}
                  title={t("search.files.tab")}
                  onClick={() => {
                    setPanelTab("search");
                    setSearchFocus((n) => n + 1);
                  }}
                >
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="m16 16 4.5 4.5" />
                  </svg>
                </button>
                <button
                  type="button"
                  role="tab"
                  className="ws-panel-tab"
                  aria-selected={panelTab === "changes"}
                  aria-label={count > 0 ? t("workspace.panel.changesCount", { count }) : t("workspace.panel.changes")}
                  title={t("workspace.panel.changes")}
                  onClick={() => setPanelTab("changes")}
                >
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 3v12M18 9a3 3 0 1 0 0-.01M6 21a3 3 0 1 0 0-.01M18 12c0 4-6 3-9 6" />
                  </svg>
                  {count > 0 && (
                    <span className="ws-panel-badge" aria-hidden="true">
                      {count}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="ws-panel-tab"
                  aria-selected={panelTab === "checks"}
                  aria-label={failing > 0 ? t("checks.tabFailing", { count: failing }) : t("checks.tab")}
                  title={t("checks.tab")}
                  onClick={() => setPanelTab("checks")}
                >
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                  </svg>
                  {failing > 0 && (
                    <span className="ws-panel-badge" data-tone="danger" aria-hidden="true">
                      {failing}
                    </span>
                  )}
                </button>
                {issuesTabVisible(issuesGit.tab, issuesPinned, panelTab === "issues") && (
                  <button
                    type="button"
                    role="tab"
                    className="ws-panel-tab"
                    aria-selected={panelTab === "issues"}
                    aria-label={t("issues.tab")}
                    title={t("issues.tab")}
                    onClick={() => setPanelTab("issues")}
                  >
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="12" r="1.5" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  className="ws-panel-tab"
                  aria-selected={panelTab === "ports"}
                  aria-label={t("ports.tab")}
                  title={t("ports.tab")}
                  onClick={() => setPanelTab("ports")}
                >
                  <Icon name="plug" size={16} />
                </button>
              </div>
              {/* Both panels stay mounted, so the change list and the open folders survive a tab switch. */}
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
                      onSearch={() => {
                        setPanelTab("search");
                        setSearchFocus((n) => n + 1);
                      }}
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
            </aside>
          </div>
        </div>

        <div className="ws-docs" hidden={view !== "docs"}>
          {docsMounted && <SurfaceBoundary id="page.docs" surface="Docs" resetKey={docsKey} titleKey="boundary.page.title"><DocsApp key={docsKey} appRequest={appRequest} kit={{ worktree: current?.path ?? null, open: kitOpen, onOpened: kitOpened, onSendToAgent: sendToAgent, canSend: target(current?.path) !== null }} /></SurfaceBoundary>}
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
              onChanged={() => {
                void load();
                void loadStatusSettings(api);
              }}
            />
          )}
        </div>
      </div>

      {/* The docs app keeps its own status bar, so this one shows with the workspace only. */}
      <LiveWorkspaceFooter
        api={api}
        branch={branch}
        running={running}
        waiting={waiting}
        version={pkg.version}
        onOpenUsage={openUsage}
        onManageAccounts={openAccounts}
        onUsageSettings={() => openSettings("usage")}
        onUseAccount={(provider, name) =>
          void api.accountActivate(provider, name).catch((e) => pushToast({ text: t("accounts.switch.failed", { code: toApiError(e).code }) }))
        }
        ports={<PortsItem store={ports} active={current?.path ?? null} onOpen={() => panelKey("ports")} />}
        hidden={view === "docs"}
      />

      {creating && repos && (
        <CreateWorktreeDialog
          repos={repos}
          repoId={creating.repoId}
          name={creating.name}
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
      <PaletteHost
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        repos={repos}
        sessions={sessions}
        history={history}
        tasks={() => api.tasks()}
        current={current}
        shownTab={current ? shownTab[current.path] ?? null : null}
        actions={{
          openTask,
          selectWorktree: (wt) => {
            select(wt);
            show("workspace");
            focusTerminal(wt.path);
          },
          showWorkspace: () => show("workspace"),
          frontTab: (worktree, id) => {
            setFront((f) => ({ worktree, id, seq: (f?.seq ?? 0) + 1 }));
            focusTerminal(worktree);
          },
          openSettings: (section, target) => openSettings(section, undefined, target),
          newWorktree: (name) => startCreate(undefined, name),
          addRepo,
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
      {switching && sessions && (
        <AccountSwitchDialog
          provider={switching.provider}
          from={switching.from}
          to={switching.to}
          rows={switching.tabIds.flatMap((id): SwitchRow[] => {
            const tab = sessions.tab(id);
            if (!tab) return [];
            const name = tab.title ?? profileName(null, tab.profileId, t);
            return [{ id, label: `${name} · ${tab.worktree.split(/[\\/]/).filter(Boolean).pop() ?? tab.worktree}`, working: tab.status === "working" }];
          })}
          onRestart={(ids, remember) => void answerSwitch(switching, ids, remember)}
          onKeep={(remember) => void answerSwitch(switching, null, remember)}
        />
      )}
      {quitting && <QuitDialog ask={quitting.ask} onChoose={quitting.answer} />}
      {about !== null && <AboutDialog version={about} onLink={(link) => void api.helpOpen(link)} onClose={() => setAbout(null)} />}
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
      <Toasts />
      {adding && (
        <AddProjectDialog
          api={api}
          startFolder={parentOf(repos?.[repos.length - 1]?.path ?? "")}
          onOpenFolder={() => void addRepoFolder()}
          onCloned={(repo) => void repoCloned(repo)}
          onCreated={(created) => void projectCreated(created)}
          onCancel={() => {
            setAdding(false);
            setScanRoot(undefined);
          }}
          scanRoot={scanRoot}
          onAddRepos={(paths) => void addScanned(paths)}
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
          onClose={() => setBoardOpen(false)}
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
    </div>
    </ProfilesProvider>
  );
}

// One array for every render, so an unlisted worktree does not look like a new list each time.
const NO_CHANGES: WorktreeChange[] = [];

function working(sessions: Sessions, path: string): number {
  return sessions.tabs(path).filter((tab) => tab.agent && tab.status === "working").length;
}

/** Agent tabs of a worktree that wait on the person. */
function waitingIn(sessions: Sessions, path: string): number {
  return sessions.tabs(path).filter((tab) => tab.agent && tab.status === "needs-you").length;
}

/** The listed name of a worktree; the folder name when the list does not have it. */
function worktreeName(list: WorktreeView[], path: string): string {
  return list.find((w) => w.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function windowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden" && (typeof document.hasFocus !== "function" || document.hasFocus());
}
