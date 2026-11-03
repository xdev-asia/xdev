import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import logo from "../../../../docs/brand/xdev-icon-512.png";
import { toApiError, type Api, type ApiError, type RepoView, type WorktreeView } from "../api";
import { DocsApp } from "../DocsApp";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { useI18n } from "../i18n";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { Sessions } from "./sessions";
import type { TabStatus } from "./status";
import { WorktreeChanges } from "./WorktreeChanges";
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

type View = "workspace" | "docs";
type Creating = { repoId: string; busy: boolean; error?: ApiError["code"] };
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<Sessions | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [notice, setNotice] = useState<ApiError["code"]>();
  // Worktrees shown so far; their tabs stay mounted, hidden, so a switch never stops a pty.
  const [visited, setVisited] = useState<string[]>([]);
  // The file a diff tab should show, for the worktree that asked.
  const [reveal, setReveal] = useState<(Reveal & { worktree: string }) | null>(null);
  // How many files the Changes panel last listed, for the worktree it listed them for.
  const [changeCount, setChangeCount] = useState<{ worktree: string; count: number } | null>(null);

  // One store of terminal tabs for the whole shell. Made in an effect so a dev double mount
  // disposes the first one.
  useEffect(() => {
    const store = new Sessions(api);
    setSessions(store);
    return () => store.dispose();
  }, [api]);

  async function load(): Promise<void> {
    try {
      setRepos(await api.workspaceList());
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
  // A string, so an unchanged store reads as the same snapshot.
  const signature = () => (sessions ? paths.map((p) => `${sessions.dot(p) ?? ""}:${working(sessions, p)}`).join("|") : "");
  useSyncExternalStore(subscribe, signature, signature);

  const dots: Record<string, TabStatus | null> = Object.fromEntries(paths.map((p) => [p, sessions?.dot(p) ?? null]));
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

  function startCreate(repoId?: string): void {
    const usable = repos?.filter((r) => !r.missing) ?? [];
    const id = repoId ?? (currentRepo && !currentRepo.missing ? currentRepo.id : usable[0]?.id);
    if (id) setCreating({ repoId: id, busy: false });
  }

  async function create(repoId: string, name: string, from: string | null): Promise<void> {
    setCreating({ repoId, busy: true });
    try {
      const wt = await api.worktreeCreate(repoId, name, from);
      setCreating(null);
      await load();
      select(wt);
    } catch (e) {
      setCreating({ repoId, busy: false, error: toApiError(e).code });
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

  const removingRepo = removing ? repos?.find((r) => r.worktrees.some((w) => w.path === removing.worktree.path)) : undefined;

  return (
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
        <div className="ws-spacer" />
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
          </nav>
          <WorktreeList
            repos={repos}
            selected={current?.path ?? null}
            dots={dots}
            notice={notice}
            onSelect={(wt) => {
              select(wt);
              show("workspace");
            }}
            onCreate={startCreate}
            onPin={(wt) => void pin(wt)}
            onRemove={(wt) => setRemoving({ worktree: wt, dirty: false, busy: false })}
            onAddRepo={addRepo}
          />
        </aside>

        <div className="ws-stage" hidden={view === "docs"}>
          <main className="ws-center" aria-label={t("workspace.center.label")}>
            {sessions &&
              mounted.map((path) => (
                <WorktreeTabs
                  key={path}
                  api={api}
                  sessions={sessions}
                  worktree={path}
                  visible={path === current?.path}
                  reveal={reveal?.worktree === path ? { file: reveal.file, seq: reveal.seq } : undefined}
                />
              ))}
            {!current && repos && (
              <div className="ws-center-empty">
                <p>{t("workspace.center.none")}</p>
              </div>
            )}
          </main>
          <aside className="ws-panel" aria-label={t("workspace.panel.label")}>
            <div className="ws-panel-tabs" role="tablist" aria-label={t("workspace.panel.label")}>
              <button
                type="button"
                role="tab"
                className="ws-panel-tab"
                aria-selected="true"
                aria-label={count > 0 ? t("workspace.panel.changesCount", { count }) : t("workspace.panel.changes")}
                title={t("workspace.panel.changes")}
              >
                <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3v12M18 9a3 3 0 1 0 0-.01M6 21a3 3 0 1 0 0-.01M18 12c0 4-6 3-9 6" />
                </svg>
                {count > 0 && (
                  <span className="ws-panel-badge" aria-hidden="true">
                    {count}
                  </span>
                )}
              </button>
            </div>
            <div className="ws-panel-body" role="tabpanel">
              {current ? (
                <WorktreeChanges
                  key={current.path}
                  api={api}
                  worktree={current}
                  sessions={sessions}
                  onOpenFile={(file) => openFile(current.path, file)}
                  onCount={(n) => setChangeCount({ worktree: current.path, count: n })}
                />
              ) : (
                <p className="ws-empty">{t("workspace.panel.empty")}</p>
              )}
            </div>
          </aside>
        </div>

        <div className="ws-docs" hidden={view !== "docs"}>
          {docsMounted && <DocsApp />}
        </div>
      </div>

      {/* The docs app keeps its own status bar, so this one shows with the workspace only. */}
      <footer className="ws-footer" hidden={view === "docs"}>
        {branch && <span className="ws-mono">{`⎇ ${branch}`}</span>}
        <span className="ws-running">
          {running > 0 && <span className="ws-dot ws-pulse" data-dot="working" aria-hidden="true" />}
          {t("workspace.footer.running", { count: running })}
        </span>
      </footer>

      {creating && repos && (
        <CreateWorktreeDialog
          repos={repos}
          repoId={creating.repoId}
          busy={creating.busy}
          error={creating.error}
          onCreate={(repoId, name, from) => void create(repoId, name, from)}
          onCancel={() => setCreating(null)}
        />
      )}
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
  );
}

function working(sessions: Sessions, path: string): number {
  return sessions.tabs(path).filter((tab) => tab.agent && tab.status === "working").length;
}
