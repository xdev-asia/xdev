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
import { countLabel, rejectPrompt } from "./changes/changes";
import { useChanges, type Problem } from "./changes/useChanges";
import { AccountsView } from "./components/AccountsView";
import { AgentContext } from "./components/AgentContext";
import { Backlinks } from "./components/Backlinks";
import { ChangesPanel, ChangeView } from "./components/ChangesPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConflictBanner } from "./components/ConflictBanner";
import { Editor } from "./components/Editor";
import { FreshnessBanner } from "./components/FreshnessBanner";
import { HistoryPanel } from "./components/HistoryPanel";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { Preview } from "./components/Preview";
import { resultId, RESULTS_ID, SearchPanel } from "./components/SearchPanel";
import { Sidebar } from "./components/Sidebar";
import { Welcome } from "./components/Welcome";
import { isDirty } from "./doc/docState";
import { agentsEditable, parseFrontmatter, setAgents, setVerified } from "./doc/frontmatter";
import { useDoc } from "./doc/useDoc";
import { useI18n } from "./i18n";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 50;
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K";

type Vault = { path: string; docs: DocEntry[] };

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [vault, setVault] = useState<Vault | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const booted = useRef(false);

  const openVault = useCallback(async (path: string) => {
    setOpening(true);
    setError(undefined);
    try {
      setVault({ path, docs: await api.openVault(path) });
    } catch (e) {
      setError(toApiError(e).code);
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
    api
      .lastVault()
      .then((path) => (path ? openVault(path) : undefined))
      .catch(() => undefined)
      .finally(() => setBooting(false));
  }, [openVault]);

  if (booting) return <div className="app-boot" />;
  if (!vault) return <Welcome onOpen={() => void pickAndOpen()} opening={opening} error={error} />;
  // Keyed by path so switching folders starts with a clean editor and search state.
  return <VaultView key={vault.path} vault={vault} onChangeFolder={pickAndOpen} />;
}

function VaultView(props: { vault: Vault; onChangeFolder(): Promise<void> }) {
  const { t } = useI18n();
  const doc = useDoc(api);
  const review = useChanges(api, doc.flush);
  const [tab, setTab] = useState<"docs" | "changes">("docs");
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState<Change[] | null>(null);
  // The doc whose history is shown; opening another doc closes the panel without extra bookkeeping.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // Takes over the main area; opening a doc or a change goes back to it.
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
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
  const { state } = doc;
  const searchOpen = query.trim() !== "";
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    setSelected(null);
    setAgentsOpen(false);
    setAccountsOpen(false);
    doc.open(path);
  }

  function selectChange(path: string | null) {
    setAgentsOpen(false);
    setAccountsOpen(false);
    setSelected(path);
  }

  function toggleAgents() {
    setAccountsOpen(false);
    setSelected(null);
    setAgentsOpen((open) => !open);
  }

  function toggleAccounts() {
    setSelected(null);
    setAgentsOpen(false);
    setAccountsOpen((open) => !open);
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

  const change = review.changes.find((c) => c.path === selected) ?? null;
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
    <div className="app">
      <header className="topbar">
        <div className="topbar-vault" title={t("vault.label", { path: props.vault.path })}>
          <span className="topbar-brand">{t("app.name")}</span>
          <span className="topbar-sep" aria-hidden="true">
            /
          </span>
          <span className="topbar-name">{folderName(props.vault.path)}</span>
        </div>
        <div className="search">
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
          <button type="button" className="btn-secondary" aria-pressed={accountsOpen} onClick={toggleAccounts}>
            {accountsOpen ? t("accounts.close") : t("accounts.title")}
          </button>
          <button type="button" className="btn-secondary" aria-pressed={agentsOpen} onClick={toggleAgents}>
            {agentsOpen ? t("agents.close") : t("agents.open")}
          </button>
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
      <aside className="sidebar">
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
          <>
            <div className="sidebar-tabs">
              <div className="segmented" role="tablist" aria-label={t("tabs.label")}>
                <button type="button" role="tab" aria-selected={tab === "docs"} onClick={() => setTab("docs")}>
                  {t("tabs.docs")}
                </button>
                <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
                  {review.status === "ok"
                    ? t("tabs.changesCount", { count: countLabel(review.changes.length) })
                    : t("tabs.changes")}
                </button>
              </div>
            </div>
            {tab === "docs" ? (
              <Sidebar docs={docs} activePath={change ? null : state.path} stale={staleDocs} onOpen={openDoc} />
            ) : (
              <ChangesPanel
                review={review}
                selected={change?.path ?? null}
                message={message}
                onMessage={setMessage}
                onSelect={selectChange}
                onApprove={(changes) => void approve(changes)}
                onReject={setRejecting}
              />
            )}
          </>
        )}
      </aside>
      <main className="main">
        {accountsOpen && <AccountsView api={api} />}
        {agentsOpen && (
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
            onClose={() => selectChange(null)}
          />
        )}
        {/* Hidden rather than unmounted, so the editor keeps its undo history while a diff is shown. */}
        <div className="docview" hidden={change !== null || agentsOpen || accountsOpen}>
          {state.path === null ? (
            <p className="placeholder">{t("editor.placeholder", { shortcut: SHORTCUT })}</p>
          ) : (
            <>
              <div className="doc-head">
                <div className="doc-titles">
                  <h1 className="doc-title">{entry?.title ?? folderName(state.path)}</h1>
                  <span className="doc-path">{state.path}</span>
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
