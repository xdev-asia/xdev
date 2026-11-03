import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import pkg from "../../package.json";
import logo from "../../../../docs/brand/xdev-icon-512.png";
import { ProfilesProvider } from "@/agents/profileStore";
import { toApiError, type Api, type ApiError, type Check, type PrView, type PtyProfile, type RepoView, type WorktreeChange, type WorktreeView } from "@/api";
import { DocsApp } from "@/DocsApp";
import type { KitTab } from "@/components/AgentKitView";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useI18n } from "@/i18n";
import { PaletteHost } from "@/palette/PaletteHost";
import { useJumpKey } from "@/palette/useJumpKey";
import { SettingsView } from "@/settings/SettingsView";
import { ChecksPanel } from "./ChecksPanel";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { FileTree } from "./FileTree";
import { HeaderSearch } from "./HeaderSearch";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { VaultNav } from "./VaultNav";
import { LiveWorkspaceFooter } from "./WorkspaceFooter";
import { sendToAgentTab } from "./agentPrompt";
import { sendTarget } from "./sendTarget";
import { Sessions } from "./sessions";
import { PrStore } from "./prs";
import { WorktreeStats } from "./stats";
import type { TabStatus } from "./status";
import { WorktreeChanges, type ChangesHandlers } from "./WorktreeChanges";
import { WorktreeList } from "./WorktreeList";
import { WorktreeTabs, type Reveal } from "./WorktreeTabs";

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
type PanelTab = "files" | "changes" | "checks";
type Creating = { repoId: string; busy: boolean; error?: ApiError["code"]; name?: string };
type Removing = { worktree: WorktreeView; dirty: boolean; busy: boolean; error?: ApiError["code"] };

/** The app frame: repos and worktrees on the left, the selected worktree in the middle. */
export function WorkspaceShell(props: { api: Api }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(() => readSelected());
  const [view, setView] = useState<View>("workspace");
  // The docs app mounts on first visit and then stays, so its editor state survives a switch.
  const [docsMounted, setDocsMounted] = useState(false);
  // A request for the Agent kit to open a tab; a new `seq` is a new request.
  const [kitOpen, setKitOpen] = useState<{ tab: KitTab; seq: number } | null>(null);
  // The tab in front of each worktree, which is where a prompt from the Agent kit is typed.
  const [shownTab, setShownTab] = useState<Record<string, string | null>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
  const [creating, setCreating] = useState<Creating | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
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

  // The line counts of the listed worktrees. The object holds nothing live until the effect
  // below attaches it, so load() can hand it the list before or after that.
  const [stats] = useState(() => new WorktreeStats());
  // Bumped when a vault opens from the sidebar, so the docs app boots again on the new folder.
  const [docsKey, setDocsKey] = useState(0);
  // Pull requests and checks of every worktree, shared by the ship bar and the panels.
  const [prs] = useState(() => new PrStore(api));
  // The jump palette, and the settings section it asked for; a new `seq` is a new request.
  const [jumpOpen, setJumpOpen] = useState(false);
  // Asks the front terminal of a worktree to take keyboard focus, as the palette closes.
  const [termFocus, setTermFocus] = useState<{ worktree: string; seq: number } | null>(null);
  const focusTerminal = (worktree: string) => setTermFocus((f) => ({ worktree, seq: (f?.seq ?? 0) + 1 }));
  const [settingsAt, setSettingsAt] = useState<{ section?: string; seq: number }>({ seq: 0 });
  // Not over a worktree dialog: it is modal, and the palette would stack on top of it.
  const dialogOpen = creating !== null || removing !== null;
  useJumpKey(useCallback(() => setJumpOpen((o) => (dialogOpen ? false : !o)), [dialogOpen]));

  // One store of terminal tabs for the whole shell. Made in an effect so a dev double mount
  // disposes the first one; disposing kills its ptys.
  useEffect(() => {
    const store = new Sessions(api);
    setSessions(store);
    stats.attach(api, store, typeof window === "undefined" ? undefined : window);
    return () => {
      stats.detach();
      store.dispose();
    };
  }, [api]);

  async function load(): Promise<void> {
    try {
      const list = await api.workspaceList();
      setRepos(list);
      stats.track(list.flatMap((r) => r.worktrees.map((w) => w.path)));
      // A worktree gone from the list (removed outside the app, say) must not keep its ptys. A
      // missing repo lists no worktrees though they may still exist, so nothing closes then.
      if (!list.some((r) => r.missing)) {
        const kept = new Set(list.flatMap((r) => r.worktrees.map((w) => w.path)));
        for (const path of sessions?.worktrees() ?? []) if (!kept.has(path)) void sessions?.closeWorktree(path);
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

  const paths = repos?.flatMap((r) => r.worktrees.map((w) => w.path)) ?? [];
  const subscribe = useCallback((listener: () => void) => sessions?.subscribe(listener) ?? (() => {}), [sessions]);
  // The live agent tab in front of a worktree, if any: where the Agent kit types.
  const target = (path: string | undefined) => (sessions && path ? sendTarget(sessions.tabs(path), shownTab[path] ?? null) : null);
  // A string, so an unchanged store reads as the same snapshot.
  const signature = () => (sessions ? paths.map((p) => `${sessions.dot(p) ?? ""}:${working(sessions, p)}:${target(p)?.id ?? ""}`).join("|") : "");
  useSyncExternalStore(subscribe, signature, signature);
  useSyncExternalStore(stats.subscribe, stats.snapshot, stats.snapshot);
  useSyncExternalStore(useCallback((fn: () => void) => prs.subscribe(fn), [prs]), () => prs.snapshot(), () => prs.snapshot());

  const dots: Record<string, TabStatus | null> = Object.fromEntries(paths.map((p) => [p, sessions?.dot(p) ?? null]));
  const activity: Record<string, number | null> = Object.fromEntries(paths.map((p) => [p, sessions?.lastActivity(p) ?? null]));
  const profiles: Record<string, PtyProfile[]> = Object.fromEntries(paths.map((p) => [p, sessions?.profilesOf(p) ?? []]));
  const running = sessions ? paths.reduce((n, p) => n + working(sessions, p), 0) : 0;

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

  function openFile(worktree: string, file: string): void {
    setReveal((r) => ({ worktree, file, seq: (r?.seq ?? 0) + 1 }));
  }

  function select(wt: WorktreeView): void {
    setSelected(wt.path);
    storeSelected(wt.path);
  }

  async function addRepo(): Promise<void> {
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
    if (id) setCreating({ repoId: id, busy: false, name });
  }

  async function create(repoId: string, name: string, from: string | null): Promise<void> {
    setCreating({ repoId, busy: true });
    try {
      const wt = await api.worktreeCreate(repoId, name, from);
      setCreating(null);
      await load();
      await openDefaultAgent(wt.path);
      select(wt);
    } catch (e) {
      setCreating({ repoId, busy: false, error: toApiError(e).code });
    }
  }

  // A new worktree starts with the default agent when it is on and installed; else nothing opens.
  async function openDefaultAgent(path: string): Promise<void> {
    if (!sessions) return;
    try {
      const view = await api.profiles();
      const found = view.profiles.find((p) => p.profile.id === view.defaultAgent);
      if (found?.profile.enabled && found.installed) sessions.open(path, found.profile.id);
    } catch {
      // The worktree is made; it just opens empty.
    }
  }

  // Terminals go first so nothing holds the folder, then the folder; uncommitted work needs a
  // second, forced confirm.
  async function remove(): Promise<void> {
    if (!removing || removing.busy) return;
    const { worktree, dirty } = removing;
    setRemoving({ worktree, dirty, busy: true });
    try {
      await sessions?.closeWorktree(worktree.path);
      await api.worktreeRemove(worktree.path, dirty, true);
      setRemoving(null);
      await load();
    } catch (e) {
      const code = toApiError(e).code;
      const nowDirty = dirty || code === "worktree_dirty";
      setRemoving({ worktree, dirty: nowDirty, busy: false, error: code === "worktree_dirty" ? undefined : code });
    }
  }

  function show(next: View): void {
    setView(next);
    if (next === "docs") setDocsMounted(true);
  }

  function openUsage(): void {
    setKitOpen((k) => ({ tab: "usage", seq: (k?.seq ?? 0) + 1 }));
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

  // Gives a failed commit hook's output to an agent of the worktree and brings its tab to the front.
  async function fixWithAgent(output: string): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const prompt = `The git commit hook failed. Fix the problem it reports, then stop; do not commit.\n\n${output}`;
    const tab = await sendToAgentTab(sessions, path, shownTab[path] ?? null, prompt);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // The docs app has the only search for now; it shows after this render, so its box is looked up then.
  function openSearch(): void {
    show("docs");
    setTimeout(() => {
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
        <img className="ws-logo" src={logo} alt="" width={18} height={18} />
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
        {/* Nothing feeds notifications yet, so that button waits, disabled. */}
        <button type="button" className="ws-icon-btn ws-header-btn" disabled aria-label={t("workspace.header.notifications")} title={t("workspace.header.soon")}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
        </button>
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
          <WorktreeList
            repos={repos}
            selected={current?.path ?? null}
            dots={dots}
            stats={stats.all()}
            activity={activity}
            profiles={profiles}
            prs={prMap}
            now={Date.now()}
            notice={notice}
            onSelect={(wt) => {
              select(wt);
              show("workspace");
            }}
            onCreate={startCreate}
            onPin={(wt) => void pin(wt)}
            onRemove={(wt) => setRemoving({ worktree: wt, dirty: false, busy: false })}
            onAddRepo={addRepo}
            onAdopt={(wt) => void adopt(wt)}
          />
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
                  visible={path === current?.path}
                  onShown={(id) => setShownTab((s) => (s[path] === id ? s : { ...s, [path]: id }))}
                  reveal={reveal?.worktree === path ? { file: reveal.file, seq: reveal.seq } : undefined}
                  front={front?.worktree === path ? { id: front.id, seq: front.seq } : undefined}
                  focusSeq={termFocus?.worktree === path ? termFocus.seq : undefined}
                />
              ))}
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
          <aside className="ws-panel" aria-label={t("workspace.panel.label")}>
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
                  onFixWithAgent={(output) => void fixWithAgent(output)}
                  register={registerChanges}
                />
              ) : (
                <p className="ws-empty">{t("workspace.panel.empty")}</p>
              )}
            </div>
            <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "checks"}>
              {current ? (
                <ChecksPanel key={current.path} api={api} worktree={current.path} prs={prs} visible={panelTab === "checks"} />
              ) : (
                <p className="ws-empty">{t("workspace.panel.empty")}</p>
              )}
            </div>
          </aside>
        </div>

        <div className="ws-docs" hidden={view !== "docs"}>
          {docsMounted && <DocsApp key={docsKey} kit={{ worktree: current?.path ?? null, open: kitOpen, onOpened: kitOpened, onSendToAgent: sendToAgent, canSend: target(current?.path) !== null }} />}
        </div>

        <div className="ws-settings" hidden={view !== "settings"}>
          {view === "settings" && <SettingsView key={settingsAt.seq} api={api} initial={settingsAt.section} onChanged={() => void load()} />}
        </div>
      </div>

      {/* The docs app keeps its own status bar, so this one shows with the workspace only. */}
      <LiveWorkspaceFooter
        api={api}
        branch={branch}
        running={running}
        // Tabs that wait on the person arrive with Plan 4; none exist yet.
        waiting={0}
        version={pkg.version}
        onOpenUsage={openUsage}
        hidden={view === "docs"}
      />

      {creating && repos && (
        <CreateWorktreeDialog
          repos={repos}
          repoId={creating.repoId}
          busy={creating.busy}
          error={creating.error}
          name={creating.name}
          onCreate={(repoId, name, from) => void create(repoId, name, from)}
          onCancel={() => setCreating(null)}
        />
      )}
      <PaletteHost
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        repos={repos}
        sessions={sessions}
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
          openSettings: (section) => {
            setSettingsAt((s) => ({ section, seq: s.seq + 1 }));
            show("settings");
          },
          newWorktree: (name) => startCreate(undefined, name),
          addRepo: () => void addRepo(),
          searchDocs: openSearch,
          toggleSidebar: () => setSidebarOpen((o) => !o),
          showDocs: () => show("docs"),
          stageAllChanges: changesReady ? () => runOnChanges((h) => h.stageAll()) : undefined,
          discardAllChanges: changesReady ? () => runOnChanges((h) => h.discardAll()) : undefined,
        }}
      />
      {removing && (
        <RemoveWorktreeDialog
          worktree={removing.worktree}
          base={removingRepo?.baseRef ?? ""}
          dirty={removing.dirty}
          busy={removing.busy}
          error={removing.error}
          onConfirm={() => void remove()}
          onCancel={() => setRemoving(null)}
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
