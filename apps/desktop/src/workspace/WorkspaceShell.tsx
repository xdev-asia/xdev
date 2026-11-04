import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import pkg from "../../package.json";
import { BrandMark } from "@/components/BrandMark";
import { ProfilesProvider, profileName } from "@/agents/profileStore";
import { SETUP_PROFILE, toApiError, type Api, type ApiError, type Check, type Created, type Linked, type OpenInApp, type OpenTarget, type HookDetail, type ScriptKind, type RepoHooks, type PrView, type PtyProfile, type DetailsPatch, type KeptBranch, type RepoGroup, type FolderEntry, type WorkStatus, type SidebarItem, type SidebarPrefs, type RepoView, type WorktreeChange, type WorktreeView } from "@/api";
import { DocsApp } from "@/DocsApp";
import type { KitTab } from "@/components/AgentKitView";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useI18n } from "@/i18n";
import { PaletteHost } from "@/palette/PaletteHost";
import { useKeymap, type ActionId } from "@/keys/keymap";
import { setTerminalKeyHost, startDiagnosticToasts } from "@/keys/terminalKey";
import { startAutosave } from "@/files/autosave";
import { fileTabId, fileTabs } from "@/files/fileTabs";
import { onOpenFile, openFile as requestOpenFile, type OpenFileRequest } from "@/files/openFile";
import { paneOf, splitPane } from "./paneTree";
import { QuickOpenDialog } from "@/search/QuickOpenDialog";
import { recentFiles } from "@/search/recentFiles";
import { SearchPanel } from "@/search/SearchPanel";
import { Toasts } from "./Toasts";
import { pushToast } from "./toastStore";
import { currentCloseWindow, openRestoredFile, restoreLayout, startLayoutSave, undoRestore, watchWindowClose } from "./layoutPersist";
import { copyText } from "@/terminal/terminalActions";
import { loadZoom, stepZoom, ZOOM_STEP } from "@/ui/zoom";
import { useJumpKey } from "@/palette/useJumpKey";
import { useNavigationSettings } from "@/settings/navigationSettings";
import { SettingsView } from "@/settings/SettingsView";
import { playStatusSound } from "@/status/sound";
import { usePresence } from "@/status/presence";
import { eventOn, getStatusSettings, loadStatusSettings, useStatusSettings } from "@/status/statusSettings";
import { BellMenu, bellCount, type BellRow } from "./BellMenu";
import { ChecksPanel } from "./ChecksPanel";
import { IssuesPanel } from "@/issues/IssuesPanel";
import { CreateWorktreeDialog, type AgentChoice, type CreateExtra } from "./CreateWorktreeDialog";
import { DetailsDialog } from "./DetailsDialog";
import { PendingCreates, type CreateArgs } from "./pendingCreates";
import { FileTree } from "./FileTree";
import { HeaderSearch } from "./HeaderSearch";
import { AddProjectDialog, parentOf } from "./AddProjectDialog";
import { RemoveRepoDialog } from "./RemoveRepoDialog";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { removeRepo } from "./removeRepo";
import { VaultNav } from "./VaultNav";
import type { AppId } from "@/shell/apps";
import { LiveWorkspaceFooter } from "./WorkspaceFooter";
import { sendCheckFix, sendFix } from "./fixAgent";
import { sendTarget } from "./sendTarget";
import { SetupCard, type SetupCardState } from "./SetupCard";
import { openDefaultTabs } from "./defaultTabs";
import { failedLinks } from "./linkReport";
import { decideSetup, hasPending, pendingLists, type PendingLists } from "./setupFlow";
import { SetupGate } from "./setupGate";
import { TrustDialog } from "./TrustDialog";
import { createNotifier, type Notifier } from "./notifier";
import { AgentSessionsStore } from "@/agentSessions/store";
import { confirmResume } from "@/agentSessions/resumeFlow";
import { SessionsSidebar } from "@/agentSessions/SessionsSidebar";
import { Sessions, type Attention, type Tab } from "./sessions";
import { PrStore } from "./prs";
import { WorktreeStats } from "./stats";
import type { TabStatus } from "./status";
import { WorktreeChanges, type ChangesHandlers } from "./WorktreeChanges";
import { worktreeTarget } from "./groups";
import { WorktreeList } from "./WorktreeList";
import { NameDialog } from "./NameDialog";
import { flattenRepos, keptByRepo } from "./sidebarModel";
import { clear as clearPicked, click as pickClick, runBulk, selectAll, type BulkResult, type Selection } from "./selection";
import { BulkBar } from "./BulkBar";
import { BulkRemoveDialog } from "./BulkRemoveDialog";
import { ReviewBranchesDialog } from "./ReviewBranchesDialog";
import { isDeleteKey, typingIn } from "./deleteKey";
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

type View = "workspace" | "docs" | "settings";
type PanelTab = "files" | "search" | "changes" | "checks" | "issues";
type Creating = { repoId: string; name?: string; agents: AgentChoice[]; defaultAgent: string | null };
type Editing = { worktree: WorktreeView; busy: boolean; error?: ApiError["code"] };
type SetupCardAt = { kind: "detected"; command: string; repoId: string } | { kind: "ask"; repoId: string };
type TrustAsk = { path: string; repoId: string; kind: ScriptKind | "lists"; text: string; hash: string; lists: PendingLists; changed: boolean; busy: boolean; error?: ApiError["code"] };
type BulkState = { mode: "delete" | "archive"; worktrees: WorktreeView[]; dirty: Record<string, boolean>; busy: boolean; result?: BulkResult };
type Review = { repoId: string | null; busy: boolean; error?: ApiError["code"] };
type Removing = { worktree: WorktreeView; dirty: boolean; busy: boolean; error?: ApiError["code"]; archiving?: boolean; failed?: { code: number | null; output: string };
  /** Removed without asking (Settings → General): the dialog stays hidden until something needs an answer. */
  quiet?: boolean;
};

/** The app frame: repos and worktrees on the left, the selected worktree in the middle. */
export function WorkspaceShell(props: { api: Api }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const { askBeforeDeleteWorktree } = useNavigationSettings();
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [items, setItems] = useState<SidebarItem[] | null>(null);
  const [prefs, setPrefs] = useState<SidebarPrefs>({ hideDefault: false, hideDetached: false, hideAutomation: false, hideCli: false });
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
  const [appRequest, setAppRequest] = useState<{ app: AppId; seq: number } | null>(null);
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
  const [sideView, setSideView] = useState<"worktrees" | "sessions">("worktrees");
  // A new `seq` asks the sessions panel for the search box, or to mark one session.
  const [sessionsAsk, setSessionsAsk] = useState<{ seq: number; focus: boolean; reveal: { key: string; seq: number } | null }>({ seq: 0, focus: false, reveal: null });
  const [creating, setCreating] = useState<Creating | null>(null);
  // Creates run after the dialog has closed; what a finished one does is read from this render.
  const afterCreate = useRef<{ api: Api; created(wt: WorktreeView, args: CreateArgs): void; reload(): void; linked(shared: Linked[]): void }>({ api, created() {}, reload() {}, linked() {} });
  const [pending] = useState(
    () =>
      new PendingCreates({
        create: (repoId, name, from) => afterCreate.current.api.worktreeCreate(repoId, name, from).then((made) => {
          afterCreate.current.linked(made.shared);
          return made.worktree;
        }),
        // Cancel was the go-ahead; a fresh worktree is clean, so its branch goes too.
        remove: (path, force) => afterCreate.current.api.worktreeRemove(path, force, true).finally(() => afterCreate.current.reload()),
        onCreated: (wt, args) => afterCreate.current.created(wt, args),
      }),
  );
  useSyncExternalStore(
    (fn) => pending.subscribe(fn),
    () => pending.version,
  );
  // Setup: the card a worktree shows, the trust prompt, and the gate that holds agents while setup runs.
  const [cards, setCards] = useState<Record<string, SetupCardAt>>({});
  const [trusting, setTrusting] = useState<TrustAsk | null>(null);
  const [gate] = useState(() => new SetupGate());
  // Which remove is current; a Cancel during the archive run bumps it so the late result is dropped.
  const removeRun = useRef(0);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<ApiError["code"]>();
  const [fixNote, setFixNote] = useState(false);
  // A request to bring a tab to the front of its worktree; a new `seq` is a new request.
  const [front, setFront] = useState<{ worktree: string; id: string; seq: number } | null>(null);
  // Worktrees shown so far; their tabs stay mounted, hidden, so a switch never stops a pty.
  const [visited, setVisited] = useState<string[]>([]);
  // The file a diff tab should show, for the worktree that asked.
  const [reveal, setReveal] = useState<(Reveal & { worktree: string }) | null>(null);
  // How many files the Changes panel last listed, for the worktree it listed them for.
  const [changeCount, setChangeCount] = useState<{ worktree: string; count: number } | null>(null);
  // The files the Changes panel last listed; the Files tree marks them.
  const [changeList, setChangeList] = useState<{ worktree: string; list: WorktreeChange[] } | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("files");
  // The window has the person: focused and not minimised. Only then is a pane on screen seen.
  const [focused, setFocused] = useState(windowFocused);
  // The terminal panes on screen in each worktree, as its tab strip reports them.
  const [panes, setPanes] = useState<Record<string, string[]>>({});
  const [bellOpen, setBellOpen] = useState(false);
  const statusSettings = useStatusSettings();
  // What the long-lived listeners read: the latest render's list, words and jump, much like a ref.
  const [live] = useState(() => ({ repos: null as RepoView[] | null, t, jump: (_id: string) => {}, openShortcuts: (_action?: string) => {}, openFileTab: (_req: OpenFileRequest) => {}, deleteKey: () => {}, notifier: null as Notifier | null }));

  // The line counts of the listed worktrees. The object holds nothing live until the effect
  // below attaches it, so load() can hand it the list before or after that.
  const [stats] = useState(() => new WorktreeStats());
  // Bumped when a vault opens from the sidebar, so the docs app boots again on the new folder.
  const [docsKey, setDocsKey] = useState(0);
  // Pull requests and checks of every worktree, shared by the ship bar and the panels.
  const [prs] = useState(() => new PrStore(api));
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
  const [openInApps, setOpenInApps] = useState<OpenInApp[]>([]);
  // A new value asks the front pane to open its quick commands popover.
  const [quickSeq, setQuickSeq] = useState(0);
  const [settingsAt, setSettingsAt] = useState<{ section?: string; arg?: string; target?: string; seq: number }>({ seq: 0 });
  // Not over a worktree dialog: it is modal, and the palette would stack on top of it.
  const dialogOpen = creating !== null || removing !== null || adding || groupName !== null || editing !== null || bulk !== null || review !== null;
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

  async function load(): Promise<void> {
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
    } catch (e) {
      setNotice(toApiError(e).code);
      setRepos((r) => r ?? []);
    }
  }

  useEffect(() => {
    void load();
    // Loaded once; every action below reloads after it changes the list.
  }, [api]);

  useEffect(() => {
    const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
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

  // Layout restore: once per run, after the registry is known and before the saver starts (a saver that
  // ran first would replace the stored layout with an empty one). Nothing runs without a worktree.
  const restoreStarted = useRef(false);
  const saver = useRef<ReturnType<typeof startLayoutSave> | null>(null);
  const flushOnClose = useRef(() => saver.current?.flush());
  const stopCloseWatch = useRef<() => void>(() => {});
  useEffect(() => {
    if (!sessions || !repos || repos.length === 0 || restoreStarted.current) return;
    restoreStarted.current = true;
    const known = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)));
    // A missing repo lists no worktrees though they may still exist: then the unknown ones stay saved.
    const incomplete = repos.some((r) => r.missing);
    void restoreLayout(api, sessions, (w) => known.has(w), openRestoredFile(api, fileTabs), () => incomplete).then((got) => {
      // The store was replaced (dev double mount) while the restore ran: this run is over.
      if (!restoreStarted.current) return;
      saver.current = startLayoutSave(api, sessions);
      if (typeof window !== "undefined") window.addEventListener("beforeunload", flushOnClose.current);
      void currentCloseWindow().then((win) => {
        if (!saver.current) return;
        stopCloseWatch.current();
        stopCloseWatch.current = watchWindowClose(saver.current, win);
      });
      if (!got || got.report.opened.length === 0) return;
      const { resumed, fresh, opened } = got.report;
      pushToast({
        text: live.t("layout.restored", { resumed, fresh }),
        actions: [{ label: live.t("layout.undo"), run: () => void undoRestore(sessions, opened) }],
      });
    });
  }, [sessions, repos]);
  useEffect(() => {
    const close = flushOnClose.current;
    return () => {
      restoreStarted.current = false;
      saver.current?.stop();
      saver.current = null;
      stopCloseWatch.current();
      stopCloseWatch.current = () => {};
      if (typeof window !== "undefined") window.removeEventListener("beforeunload", close);
    };
  }, [sessions]);

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

  const all = repos?.flatMap((r) => r.worktrees) ?? [];
  // A stored path that no longer exists falls back to the first worktree.
  const current = all.find((w) => w.path === selected) ?? all[0] ?? null;
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
  const counted = (tab: Tab) => eventOn(statusSettings, tab.unreadReason ?? "needs-you");
  const unreadTabs = (sessions?.unreadTabs() ?? []).filter(counted);
  const unreadCount = statusSettings.enabled ? (sessions?.unreadWorktrees(counted).length ?? 0) : 0;
  useEffect(() => {
    live.notifier?.badge(unreadCount);
  }, [sessions, unreadCount, statusSettings.badge]);
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

  function jumpTo(id: string): void {
    if (!sessions) return;
    const tab = sessions
      .worktrees()
      .flatMap((w) => sessions.tabs(w))
      .find((x) => x.id === id);
    const wt = tab ? all.find((w) => w.path === tab.worktree) : undefined;
    if (!tab || !wt) return;
    select(wt);
    show("workspace");
    setBellOpen(false);
    setFront((f) => ({ worktree: wt.path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
    // The pane shows after this render; its terminal is looked up then.
    setTimeout(() => {
      if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
      const pane = [...document.querySelectorAll<HTMLElement>(".ws-tab-pane")].find((el) => el.dataset.tab === tab.id);
      pane?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
    }, 0);
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
  useEffect(() => onOpenFile((req) => recentFiles.touch(req.worktree, req.rel)), []);
  // Ctrl+Enter in quick open: the file goes into a new pane to the right of the focused one.
  function openFileSide(worktree: string, rel: string, line?: number): void {
    const layout = sessions?.layout(worktree);
    const id = fileTabId(rel);
    if (sessions && layout && !paneOf(layout, id)) sessions.setLayout(worktree, splitPane(layout, layout.focused, "right", id));
    requestOpenFile({ worktree, rel, line });
  }
  useEffect(() => startAutosave(api, fileTabs, t), [api, t]);

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

  function select(wt: WorktreeView): void {
    setSelected(wt.path);
    storeSelected(wt.path);
  }

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
  }
  useEffect(() => startQuickCommands(api), [api]);
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
    "settings.open": () => openSettings(),
    "quickCommands.open": () => setQuickSeq((n) => n + 1),
    "settings.shortcuts": () => openSettings("keys"),
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
    "zoom.in": () => void stepZoom(api, ZOOM_STEP),
    "zoom.out": () => void stepZoom(api, -ZOOM_STEP),
    "zoom.reset": () => void stepZoom(api, 0),
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
    setAdding(true);
  }

  async function addRepoFolder(): Promise<void> {
    setAdding(false);
    setNotice(undefined);
    const path = await api.pickFolder().catch(() => null);
    if (!path) return;
    try {
      const repo = await api.repoAdd(path);
      await load();
      if (repo.worktrees[0]) select(repo.worktrees[0]);
    } catch (e) {
      setNotice(toApiError(e).code);
    }
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
    if (kept.length === 0) return;
    pushToast({ text: t("review.notice", { count: kept.length }), actions: [{ label: t("review.notice.button"), run: () => setReview({ repoId: null, busy: false }) }] });
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
    const op = (p: string) => (b.mode === "archive" ? api.worktreeArchive(p, opts.anyway, true) : api.worktreeRemove(p, opts.anyway, true));
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
  function startRemove(wt: WorktreeView): void {
    const next: Removing = { worktree: wt, dirty: false, busy: false };
    if (askBeforeDeleteWorktree) return setRemoving(next);
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
  function create(repoId: string, name: string, from: string | null, extra?: CreateExtra): void {
    setCreating(null);
    pending.start({ repoId, name, from, ...(extra ? { extra } : {}) });
  }

  async function created(wt: WorktreeView, args: CreateArgs): Promise<void> {
    const extra = args.extra;
    if (extra) await applyCreateExtra(wt.path, extra);
    await load();
    await setupAfterCreate(wt.path, args.repoId);
    // Dialog: the agent it picked, or none. No dialog: the default agent.
    await openDefaultAgent(wt.path, extra ? extra.agent : undefined);
    select(wt);
  }
  afterCreate.current = { api, created: (wt, args) => void created(wt, args), reload: () => void load(), linked: reportLinks };

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

  // A new worktree starts with the agent picked for it, or the default one when none was asked for; it must be on and installed.
  async function openDefaultAgent(path: string, pick?: string | null): Promise<void> {
    if (!sessions || pick === null) return;
    try {
      const view = await api.profiles();
      const found = view.profiles.find((p) => p.profile.id === (pick ?? view.defaultAgent));
      if (found?.profile.enabled && found.installed) {
        const id = found.profile.id;
        // With the repo set to wait, the agent starts when the setup tab has exited.
        if (!gate.defer(path, () => void sessions.open(path, id))) sessions.open(path, id);
      }
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
          await api.worktreeRemove(child.path, false, true);
        }
      }
      const done = await api.worktreeRemove(worktree.path, dirty, true);
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

  function openSettings(section?: string, arg?: string, target?: string): void {
    setSettingsAt((s) => ({ section, arg, target, seq: s.seq + 1 }));
    show("settings");
  }

  function show(next: View): void {
    setView(next);
    if (next === "docs") setDocsMounted(true);
  }

  function openUsage(): void {
    setKitOpen((k) => ({ tab: "usage", seq: (k?.seq ?? 0) + 1 }));
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

  // Gives a failed check, with its log when there is one, to an agent of the worktree.
  async function fixCheck(check: Check): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendCheckFix(api, sessions, path, shownTab[path] ?? null, current.branch ?? "", check);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
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
          {statusSettings.bell && bellOpen && <BellMenu rows={bellRows} now={Date.now()} onJump={(tab) => jumpTo(tab.id)} onClose={() => setBellOpen(false)} />}
        </div>
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
            {(["worktrees", "sessions"] as const).map((v) => (
              <button key={v} type="button" className="ws-side-tab" aria-pressed={sideView === v} onClick={() => setSideView(v)}>
                {t(`agentSessions.tab.${v}`)}
              </button>
            ))}
          </div>
          {sessions && history && (
            <div className="ws-side-view" hidden={sideView !== "sessions"}>
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
              onStatus={(status: WorkStatus) => void bulkEach((path) => api.worktreeDetails(path, { status }))}
              onClear={() => setPicked(clearPicked())}
            />
          )}
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
            onEditDetails={(wt) => setEditing({ worktree: wt, busy: false })}
            onCopyLink={(url) => {
              void copy(url);
              pushToast({ text: t("workItem.copied") });
            }}
            selected={current?.path ?? null}
            dots={dots}
            stats={stats.all()}
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
            onMarkUnread={(wt) => sessions?.markUnread(wt.path)}
            onMarkRead={(wt) => sessions?.markRead(wt.path)}
            openInApps={openInApps}
            onOpenIn={(path, target) => void openIn(path, target)}
            onCopy={(text) => void copy(text)}
            onNewTerminal={(wt) => void newTerminalIn(wt)}
            onRepoSettings={(repo) => openSettings("repos", repo.id)}
            onRemoveRepo={(repo) => setForgetting({ repo })}
          />
          </div>
        </aside>

        <div className="ws-stage" hidden={view !== "workspace"}>
          <main className="ws-center" aria-label={t("workspace.center.label")}>
            {sessions &&
              mounted.map((path) => (
                <WorktreeTabs
                  key={path}
                  api={api}
                  sessions={sessions}
                  worktree={path}
                  branch={repos?.flatMap((r) => r.worktrees).find((w) => w.path === path)?.branch ?? null}
                  visible={path === current?.path}
                  onShown={(id) => setShownTab((s) => (s[path] === id ? s : { ...s, [path]: id }))}
                  onPanes={(ids) => setPanes((s) => (s[path]?.join(" ") === ids.join(" ") ? s : { ...s, [path]: ids }))}
                  reveal={reveal?.worktree === path ? { file: reveal.file, seq: reveal.seq } : undefined}
                  front={front?.worktree === path ? { id: front.id, seq: front.seq } : undefined}
                  focusSeq={termFocus?.worktree === path ? termFocus.seq : undefined}
                  onShowHistory={showInHistory}
                  gate={gate}
                  repo={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.path ?? null}
                  repoName={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.shortName ?? ""}
                  quickSeq={path === current?.path ? quickSeq : undefined}
                  onManageQuickCommands={() => openSettings("qcmd")}
                />
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
            </div>
            {/* Both panels stay mounted, so the change list and the open folders survive a tab switch. */}
            <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "files"}>
              {current ? (
                <FileTree
                  key={current.path}
                  api={api}
                  worktree={current.path}
                  changes={markedChanges}
                  onOpen={(file) => openFile(current.path, file)}
                />
              ) : (
                <p className="ws-empty">{t("workspace.panel.empty")}</p>
              )}
            </div>
            <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "search"}>
              <SearchPanel
                key={current?.path ?? ""}
                api={api}
                worktree={current?.path ?? null}
                focusSeq={searchFocus}
                onOpen={(rel, at) => current && requestOpenFile({ worktree: current.path, rel, line: at.line, column: at.column })}
              />
            </div>
            <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "changes"}>
              {current ? (
                <WorktreeChanges
                  key={current.path}
                  api={api}
                  worktree={current}
                  sessions={sessions}
                  prs={prs}
                  onOpenFile={(file) => openFile(current.path, file)}
                  onCount={(n) => setChangeCount({ worktree: current.path, count: n })}
                  onChanges={(list) => setChangeList({ worktree: current.path, list })}
                  onFixWithAgent={(output) => void fixWithAgent("fixCommitFailure", output)}
                  onFixPush={(output, branch) => void fixWithAgent("fixPushFailure", output, branch)}
                  onOpenGitSettings={() => openSettings("git")}
                  register={registerChanges}
                />
              ) : (
                <p className="ws-empty">{t("workspace.panel.empty")}</p>
              )}
            </div>
            <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "checks"}>
              {current ? (
                <ChecksPanel key={current.path} api={api} worktree={current.path} prs={prs} visible={panelTab === "checks"} onFix={(check) => fixCheck(check)} />
              ) : (
                <p className="ws-empty">{t("workspace.panel.empty")}</p>
              )}
            </div>
            <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "issues"}>
              {currentRepo && !currentRepo.missing ? (
                <IssuesPanel key={currentRepo.id} api={api} repoId={currentRepo.id} />
              ) : (
                <p className="ws-empty">{t("workspace.panel.empty")}</p>
              )}
            </div>
          </aside>
        </div>

        <div className="ws-docs" hidden={view !== "docs"}>
          {docsMounted && <DocsApp key={docsKey} appRequest={appRequest} kit={{ worktree: current?.path ?? null, open: kitOpen, onOpened: kitOpened, onSendToAgent: sendToAgent, canSend: target(current?.path) !== null }} />}
        </div>

        <div className="ws-settings" hidden={view !== "settings"}>
          {view === "settings" && (
            <SettingsView
              key={settingsAt.seq}
              api={api}
              initial={settingsAt.section}
              arg={settingsAt.arg}
              target={settingsAt.target}
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
        hidden={view === "docs"}
      />

      {creating && repos && (
        <CreateWorktreeDialog
          repos={repos}
          repoId={creating.repoId}
          name={creating.name}
          agents={creating.agents}
          defaultAgent={creating.defaultAgent}
          onCreate={(repoId, name, from, extra) => create(repoId, name, from, extra)}
          onCancel={() => setCreating(null)}
        />
      )}
      <QuickOpenDialog
        open={quickOpen}
        api={api}
        worktree={current?.path ?? null}
        recent={recentFiles}
        onClose={() => setQuickOpen(false)}
        onOpen={(rel, { line, side }) => {
          if (!current) return;
          if (side) openFileSide(current.path, rel, line);
          else requestOpenFile({ worktree: current.path, rel, line });
        }}
      />
      <PaletteHost
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        repos={repos}
        sessions={sessions}
        history={history}
        current={current}
        shownTab={current ? shownTab[current.path] ?? null : null}
        actions={{
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
      <Toasts />
      {adding && (
        <AddProjectDialog
          api={api}
          startFolder={parentOf(repos?.[repos.length - 1]?.path ?? "")}
          onOpenFolder={() => void addRepoFolder()}
          onCloned={(repo) => void repoCloned(repo)}
          onCreated={(created) => void projectCreated(created)}
          onCancel={() => setAdding(false)}
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
          worktree={editing.worktree}
          siblings={repos?.find((r) => r.worktrees.some((w) => w.path === editing.worktree.path))?.worktrees ?? []}
          busy={editing.busy}
          error={editing.error}
          onSave={(patch) => void saveDetails(patch)}
          onCancel={() => setEditing(null)}
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
          onArchive={() => void archiveRemoving()}
          children={all.filter((c) => c.parent === removing.worktree.path).length}
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
