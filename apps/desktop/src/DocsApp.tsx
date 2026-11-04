import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  api,
  toApiError,
  type ApiError,
  type Change,
  type DocEntry,
  type Freshness,
  type SearchHit,
  type StaleDoc,
} from "./api";
import { rejectPrompt } from "./changes/changes";
import { useChanges, type Problem } from "./changes/useChanges";
import { AccountsView } from "./components/AccountsView";
import { ActivityBar } from "./components/ActivityBar";
import { AgentContext } from "./components/AgentContext";
import { AgentKitView, type KitHost } from "./components/AgentKitView";
import { Backlinks } from "./components/Backlinks";
import { ChangesPanel, ChangeView, ICON, Icon } from "./components/ChangesPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConflictBanner } from "./components/ConflictBanner";
import { CreateVaultDialog } from "./components/CreateVaultDialog";
import { Editor } from "./components/Editor";
import { FreshnessBanner } from "./components/FreshnessBanner";
import { HistoryPanel } from "./components/HistoryPanel";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { NoVaultView, type VaultFailure } from "./components/NoVaultView";
import { Preview } from "./components/Preview";
import { resultId, RESULTS_ID, SearchPanel } from "./components/SearchPanel";
import { NewDocForm } from "./components/NewDocForm";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { SquadsView } from "./components/SquadsView";
import { TasksView } from "./components/TasksView";
import { useKeymap } from "./keys/keymap";
import { TerminalView } from "./terminal/TerminalView";
import { isDirty } from "./doc/docState";
import { agentsEditable, parseFrontmatter, setAgents, setVerified } from "./doc/frontmatter";
import { useDoc } from "./doc/useDoc";
import { useI18n } from "./i18n";
import type { AppId } from "./shell/apps";
import { docFileName, newDocContent } from "./shell/newDoc";
import { setUpVault } from "./shell/setUpVault";
import { useQuota } from "./shell/useQuota";
import { useUpdate } from "./shell/useUpdate";
import { BrandMark } from "@/components/BrandMark";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 50;
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K";

// `open` is a doc to show first, e.g. the starter doc of a folder just created.
type Vault = { path: string; docs: DocEntry[]; open?: string };

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/** Docs & SDLC: the vault, its docs and the agents that work on them. */
export type AppRequest = { app: AppId; seq: number; task?: string };

export function DocsApp(props: { kit?: KitHost; appRequest?: AppRequest | null }) {
  const { t } = useI18n();
  const [booting, setBooting] = useState(true);
  const [vault, setVault] = useState<Vault | null>(null);
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<VaultFailure>();
  const [defaultPath, setDefaultPath] = useState("");
  // The create dialog: closed, or open with the path being edited and the last error.
  const [creating, setCreating] = useState<{ path: string; error?: ApiError["code"] } | null>(null);
  const booted = useRef(false);

  const openVault = useCallback(async (path: string) => {
    setOpening(true);
    try {
      setVault({ path, docs: await api.openVault(path) });
      setFailure(undefined);
    } catch (e) {
      setFailure({ path, code: toApiError(e).code });
    } finally {
      setOpening(false);
    }
  }, []);

  const pickAndOpen = useCallback(async () => {
    const path = await api.pickFolder().catch(() => null);
    if (path) await openVault(path);
  }, [openVault]);

  useEffect(() => {
    // StrictMode runs effects twice in dev; opening the vault twice would race.
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      const path = await api.lastVault().catch(() => null);
      if (path) await openVault(path);
      const setup = await api.vaultSetup().catch(() => null);
      if (setup) {
        setDefaultPath(setup.defaultPath);
        if (setup.prompt && !path) setCreating({ path: setup.defaultPath });
      }
      setBooting(false);
    })();
  }, [openVault]);

  async function create() {
    if (!creating) return;
    const path = creating.path.trim();
    setOpening(true);
    try {
      const starter = { file: t("vault.starter.file"), content: t("vault.starter.content") };
      const docs = await setUpVault(api, path, starter);
      setCreating(null);
      setFailure(undefined);
      setVault({ path, docs, open: docs.some((d) => d.path === starter.file) ? starter.file : undefined });
    } catch (e) {
      setCreating({ path, error: toApiError(e).code });
    } finally {
      setOpening(false);
    }
  }

  async function pickForCreate() {
    const path = await api.pickFolder().catch(() => null);
    if (path) setCreating({ path });
  }

  function cancelCreate() {
    setCreating(null);
    // Answering "not now" counts as answering: later launches without a folder skip the offer.
    void api.dismissVaultPrompt().catch(() => undefined);
  }

  if (booting) {
    return (
      <div className="app-boot" role="status">
        {t("vault.opening")}
      </div>
    );
  }
  return (
    <>
      {vault ? (
        // Keyed by path so switching folders starts with a clean editor and search state.
        <VaultView key={vault.path} vault={vault} kit={props.kit} appRequest={props.appRequest} onChangeFolder={pickAndOpen} />
      ) : (
        <NoVaultView
          kit={props.kit}
          appRequest={props.appRequest}
          failure={failure}
          busy={opening}
          onCreate={() => setCreating({ path: defaultPath })}
          onOpen={() => void pickAndOpen()}
        />
      )}
      <CreateVaultDialog
        open={creating !== null}
        path={creating?.path ?? ""}
        busy={opening}
        error={creating?.error}
        onPath={(path) => setCreating({ path })}
        onPick={() => void pickForCreate()}
        onCreate={() => void create()}
        onCancel={cancelCreate}
      />
    </>
  );
}

export function VaultView(props: { vault: Vault; kit?: KitHost; appRequest?: AppRequest | null; onChangeFolder(): Promise<void> }) {
  const { t } = useI18n();
  const doc = useDoc(api);
  const review = useChanges(api, doc.flush);
  const [app, setApp] = useState<AppId>("docs");
  // Set once the Agent kit has been shown; from then on it stays mounted.
  const kitSeen = useRef(false);
  if (app === "kit") kitSeen.current = true;
  // The task a squad link asked Tasks to show.
  // `seq` bumps on each focus, so picking the same task again remounts Tasks on it.
  const [taskFocus, setTaskFocusState] = useState<{ id: string; seq: number } | null>(null);
  const setTaskFocus = (id: string) => setTaskFocusState((f) => ({ id, seq: (f?.seq ?? 0) + 1 }));
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState<Change[] | null>(null);
  // The doc whose history is shown; opening another doc closes the panel without extra bookkeeping.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [docs, setDocs] = useState(props.vault.docs);
  // One choice for the whole session, so moving between docs keeps reading (or editing) mode.
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<ApiError["code"]>();
  const [active, setActive] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  // Tagged with its path, so a slow answer for the previous doc is never shown on the next one.
  const [freshness, setFreshness] = useState<{ path: string; value: Freshness; now: number }>();
  const [staleDocs, setStaleDocs] = useState<StaleDoc[]>([]);
  // Open while the sidebar shows the new-doc form.
  const [newDoc, setNewDoc] = useState<{ busy: boolean; error?: ApiError["code"] } | null>(null);
  // A doc just created from its title gets the cursor, so typing goes straight below the heading.
  const [typeInto, setTypeInto] = useState<string | null>(null);
  const { state } = doc;
  const searchOpen = query.trim() !== "";
  const { quota } = useQuota(api, app === "accounts");
  const update = useUpdate(api);
  const loading = state.status === "loading";

  useEffect(() => {
    const path = state.path;
    if (path === null || loading) return;
    let stale = false;
    api.docFreshness(path).then(
      (value) => !stale && setFreshness({ path, value, now: Math.floor(Date.now() / 1000) }),
      // A doc that cannot be checked just shows no banner; the editor already reports read errors.
      () => !stale && setFreshness(undefined),
    );
    return () => {
      stale = true;
    };
    // `state.saved` covers open and save; the revisions cover commits and edits made elsewhere.
  }, [state.path, state.saved, loading, revision, review.revision]);

  useEffect(() => {
    let stale = false;
    api.staleDocs().then(
      (found) => !stale && setStaleDocs(found),
      () => !stale && setStaleDocs([]),
    );
    return () => {
      stale = true;
    };
  }, [revision, review.revision]);

  useEffect(() => {
    if (props.vault.open) doc.open(props.vault.open);
    // Only on mount: the vault is fixed for this view's lifetime (it is keyed by path).
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void api
      .onVaultChanged(() => {
        api.listDocs().then(setDocs, () => undefined);
        // Re-runs an open search so results reflect the updated index.
        setRevision((r) => r + 1);
      })
      .then((unlisten) => (disposed ? unlisten() : (off = unlisten)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearching(false);
      setSearchError(undefined);
      return;
    }
    setSearching(true);
    let stale = false;
    const timer = setTimeout(() => {
      api.search(q, SEARCH_LIMIT).then(
        (found) => {
          if (stale) return;
          setHits(found);
          setActive(0);
          setSearchError(undefined);
          setSearching(false);
        },
        (e: unknown) => {
          if (stale) return;
          setSearchError(toApiError(e).code);
          setSearching(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, revision]);

  // The keymap only runs these while the docs view is shown, though the workspace keeps it mounted.
  useKeymap({
    "docs.search": () => {
      searchInput.current?.focus();
      searchInput.current?.select();
    },
    "docs.new": () => startNewDoc(),
  });

  useEffect(() => {
    // Approved or rejected (here or in a terminal): there is nothing left to diff, so back to the doc.
    if (selected !== null && review.status === "ok" && !review.changes.some((c) => c.path === selected)) {
      setSelected(null);
    }
  }, [selected, review.status, review.changes]);

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(Math.max(i + step, 0), Math.max(hits.length - 1, 0)));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      openDoc(hits[active].path);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  }

  function changeFolder() {
    // Flush pending edits to the current vault before the session can switch away.
    doc.save();
    void props.onChangeFolder();
  }

  function openDoc(path: string) {
    setTypeInto(null);
    setSelected(null);
    setApp("docs");
    doc.open(path);
  }

  function startNewDoc() {
    setQuery("");
    setApp("docs");
    setNewDoc({ busy: false });
  }

  async function createDoc(title: string) {
    const path = docFileName(title);
    if (path === null) {
      setNewDoc({ busy: false, error: "bad_path" });
      return;
    }
    setNewDoc({ busy: true });
    try {
      await api.createDoc(path, newDocContent(title));
    } catch (e) {
      setNewDoc({ busy: false, error: toApiError(e).code });
      return;
    }
    setNewDoc(null);
    // The watcher skips the app's own writes, so the list and the change count are refreshed here.
    api.listDocs().then(setDocs, () => undefined);
    review.refresh();
    setMode("edit");
    openDoc(path);
    setTypeInto(path);
  }

  function selectChange(path: string | null) {
    setSelected(path);
  }

  // A request from the shell (the footer link) shows the Agent kit on the tab it names.
  // The Kit hands the request back once it shows it, so a later mount finds none waiting.
  const kitRequest = props.kit?.open ?? null;
  useEffect(() => {
    if (kitRequest) openApp("kit");
    // `openApp` only sets state, so the request alone decides when this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitRequest]);

  // A request from the shell (the usage popover) shows the app it names.
  const appSeq = props.appRequest?.seq;
  useEffect(() => {
    if (!props.appRequest) return;
    // A task in the request is the `onOpenTask` path: focus it, then show Tasks.
    if (props.appRequest.task) setTaskFocus(props.appRequest.task);
    openApp(props.appRequest.app);
    // Only a new request runs this; `openApp` just sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSeq]);

  function openApp(next: AppId) {
    // A diff belongs to Changes; elsewhere the main area goes back to the open doc.
    if (next !== "changes") setSelected(null);
    // Picking an app is a request for its panel, which search results would otherwise cover.
    setQuery("");
    setApp(next);
  }

  async function approve(changes: Change[]) {
    if (await review.approve(changes, message)) setMessage("");
  }

  async function confirmReject() {
    const targets = rejecting ?? [];
    setRejecting(null);
    // Rejecting an added file deletes it; an editor left open on it would recreate it on the next save.
    const deletesOpenDoc = targets.some((c) => c.kind === "added" && c.path === state.path);
    if ((await review.reject(targets)) && deletesOpenDoc) doc.close();
  }

  async function restore(path: string, id: string): Promise<Problem | null> {
    // An autosave landing after the restore would overwrite it with the old draft.
    if (!(await doc.flush())) return { code: "unsaved" };
    try {
      await api.restoreVersion(path, id);
    } catch (e) {
      return toApiError(e);
    }
    setHistoryFor(null);
    doc.open(path);
    review.refresh();
    return null;
  }

  // Opening Changes should show a diff straight away, not the doc that was open before.
  const change =
    review.changes.find((c) => c.path === selected) ?? (app === "changes" ? (review.changes[0] ?? null) : null);
  // Search results need the panel whichever app is open.
  const panelOpen = searchOpen || app === "docs" || app === "changes";
  // Loading or a failed read is not "untracked"; the status bar leaves the item out instead.
  const changeCount = review.status === "ok" ? review.changes.length : review.status === "loading" || review.status === "error" ? undefined : null;
  const prompt = rejecting && rejecting.length > 0 ? rejectPrompt(rejecting) : null;
  const entry = docs.find((d) => d.path === state.path);
  const dirty = isDirty(state);
  const docPaths = useMemo(() => docs.map((d) => d.path), [docs]);
  const forAgents = useMemo(() => parseFrontmatter(state.draft).fm.agents.length > 0, [state.draft]);
  const agentsLocked = !agentsEditable(state.draft);
  const readOnly = state.status === "error" && !dirty;
  const tracked = review.status === "ok";
  const historyPath = tracked && historyFor === state.path && state.status !== "loading" ? historyFor : null;
  const historyOpen = historyPath !== null;
  const saveLabel =
    state.status === "loading"
      ? t("editor.loading")
      : state.status === "saving"
        ? t("editor.saving")
        : dirty
          ? t("editor.unsaved")
          : t("editor.saved");

  return (
    <div className="app" data-panel={panelOpen ? undefined : "off"}>
      <header className="topbar">
        <div className="topbar-vault" title={t("vault.label", { path: props.vault.path })}>
          <BrandMark className="topbar-logo" size={20} />
          <span className="topbar-brand">{t("app.name")}</span>
          <span className="topbar-folder">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span className="topbar-name">{folderName(props.vault.path)}</span>
          </span>
        </div>
        <div className="search">
          <svg className="search-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchInput}
            type="search"
            className="search-input"
            value={query}
            placeholder={t("search.placeholder", { shortcut: SHORTCUT })}
            aria-label={t("search.label")}
            aria-controls={RESULTS_ID}
            aria-activedescendant={searchOpen && hits[active] ? resultId(active) : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={changeFolder}
            disabled={state.status === "conflict"}
          >
            {t("vault.change")}
          </button>
          <LanguageSwitch />
        </div>
      </header>
      <ActivityBar active={app} changeCount={changeCount ?? null} onSelect={openApp} />
      <aside className="sidebar" hidden={!panelOpen}>
        {searchOpen ? (
          <SearchPanel
            query={query}
            hits={hits}
            searching={searching}
            error={searchError}
            activeIndex={active}
            onOpen={openDoc}
          />
        ) : (
          app === "docs" ? (
            <Sidebar
              docs={docs}
              activePath={state.path}
              stale={staleDocs}
              onOpen={openDoc}
              onNew={startNewDoc}
              newDoc={
                newDoc && (
                  <NewDocForm
                    busy={newDoc.busy}
                    error={newDoc.error}
                    onCreate={(title) => void createDoc(title)}
                    onCancel={() => setNewDoc(null)}
                  />
                )
              }
            />
          ) : (
            app === "changes" && (
              <ChangesPanel
                review={review}
                selected={change?.path ?? null}
                message={message}
                onMessage={setMessage}
                onSelect={selectChange}
                onApprove={(changes) => void approve(changes)}
                onReject={setRejecting}
              />
            )
          )
        )}
      </aside>
      <main className="main">
        {app === "tasks" && <TasksView key={taskFocus ? `${taskFocus.id}:${taskFocus.seq}` : ""} api={api} initial={taskFocus?.id} />}
        {app === "squads" && (
          <SquadsView
            api={api}
            onOpenTask={(id) => {
              setTaskFocus(id);
              openApp("tasks");
            }}
          />
        )}
        {app === "accounts" && <AccountsView api={api} />}
        {/* Hidden rather than unmounted once shown, so an open file or a typed prompt survives. */}
        {kitSeen.current && (
          <div className="kitview" hidden={app !== "kit"}>
            <AgentKitView
              api={api}
              worktree={props.kit?.worktree ?? null}
              request={props.kit?.open}
              onRequestHandled={props.kit?.onOpened}
              onSendToAgent={props.kit?.onSendToAgent}
              canSend={props.kit?.canSend}
              onOpenContext={() => openApp("agents")}
            />
          </div>
        )}
        {app === "agents" && (
          <AgentContext
            api={api}
            revision={revision}
            flush={doc.flush}
            vaultPath={props.vault.path}
            onOpenDoc={openDoc}
          />
        )}
        {change && (
          <ChangeView
            key={change.path}
            api={api}
            change={change}
            revision={review.revision}
            busy={review.busy}
            onApprove={() => void approve([change])}
            onReject={() => setRejecting([change])}
            onOpenDoc={() => openDoc(change.path)}
            onClose={() => openApp("docs")}
          />
        )}
        {app === "changes" && !change && review.status === "ok" && (
          <div className="placeholder changes-empty">
            <span className="changes-empty-icon">
              <Icon d={ICON.check} size={28} />
            </span>
            <p>{t("changes.empty.main")}</p>
          </div>
        )}
        {/* Hidden rather than unmounted, so a running terminal survives switching views. */}
        <div className="terminalview" hidden={app !== "terminal"}>
          <TerminalView api={api} />
        </div>
        {/* Hidden rather than unmounted, so the editor keeps its undo history while a diff is shown. */}
        <div className="docview" hidden={app !== "docs"}>
          {state.path === null ? (
            <p className="placeholder">{t("editor.placeholder", { shortcut: SHORTCUT })}</p>
          ) : (
            <>
              <div className="doc-head">
                <div className="doc-titles">
                  <span className="doc-path">{state.path}</span>
                  <h1 className="doc-title">{entry?.title ?? folderName(state.path)}</h1>
                </div>
                <div className="doc-actions">
                  <div className="segmented" role="group" aria-label={t("doc.mode.label")}>
                    <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
                      {t("doc.mode.edit")}
                    </button>
                    <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
                      {t("doc.mode.preview")}
                    </button>
                  </div>
                  {/* A hand-written target list cannot be toggled without losing it, so it is only shown. */}
                  <label className="doc-agents" title={agentsLocked ? t("doc.agentsList") : undefined}>
                    <input
                      type="checkbox"
                      checked={forAgents}
                      disabled={agentsLocked || readOnly || state.status === "loading"}
                      onChange={(e) => doc.edit(setAgents(state.draft, e.target.checked))}
                    />
                    {t("doc.agents")}
                  </label>
                  <span className="doc-status" data-dirty={dirty || undefined} aria-live="polite">
                    {saveLabel}
                  </span>
                  {tracked && (
                    <button
                      type="button"
                      className="btn-secondary"
                      aria-pressed={historyOpen}
                      disabled={state.status === "loading"}
                      onClick={() => setHistoryFor(historyOpen ? null : state.path)}
                    >
                      {historyOpen ? t("history.close") : t("history.open")}
                    </button>
                  )}
                </div>
              </div>
              {state.status === "conflict" && (
                <ConflictBanner onReload={() => doc.resolve("reload")} onKeep={() => doc.resolve("keep")} />
              )}
              {state.status === "error" && state.error && (
                <div className="banner banner-warn" role="alert">
                  <span className="banner-text">{t(`error.${state.error}`)}</span>
                </div>
              )}
              {freshness?.path === state.path && !loading && (
                <FreshnessBanner
                  freshness={freshness.value}
                  draft={state.draft}
                  now={freshness.now}
                  disabled={readOnly || state.status === "conflict"}
                  onMarkVerified={(head) => doc.edit(setVerified(state.draft, head))}
                />
              )}
              {state.status === "loading" ? (
                <p className="placeholder">{t("editor.loading")}</p>
              ) : (
                <>
                  {historyPath !== null && (
                    <HistoryPanel
                      key={historyPath}
                      api={api}
                      path={historyPath}
                      current={state.draft}
                      revision={review.revision}
                      onRestore={(id) => restore(historyPath, id)}
                    />
                  )}
                  <div className="docbody" hidden={historyOpen}>
                    {mode === "preview" && (
                      <Preview path={state.path} content={state.draft} docs={docPaths} onOpen={openDoc} />
                    )}
                    {/* Hidden in preview rather than unmounted, so undo history survives a look at the preview. */}
                    <div className="docbody-edit" hidden={mode === "preview"}>
                      {/* Remounting per doc keeps undo history from leaking between files. */}
                      <Editor
                        key={state.path}
                        value={state.draft}
                        onChange={doc.edit}
                        onSave={doc.save}
                        readOnly={readOnly}
                        autoFocus={state.path === typeInto}
                      />
                    </div>
                    <Backlinks api={api} path={state.path} revision={revision} onOpen={openDoc} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
      <StatusBar
        vault={{ name: folderName(props.vault.path), docCount: docs.length, staleCount: staleDocs.length, changeCount }}
        quota={quota}
        update={update.state}
        onRestartUpdate={update.restart}
        onOpen={openApp}
      />
      <ConfirmDialog
        open={prompt !== null}
        title={prompt ? t(prompt.key, prompt.vars) : ""}
        body={t("changes.reject.body")}
        confirmLabel={t("changes.reject")}
        onConfirm={() => void confirmReject()}
        onCancel={() => setRejecting(null)}
      />
    </div>
  );
}
