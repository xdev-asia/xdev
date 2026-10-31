import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, toApiError, type ApiError, type Change, type DocEntry, type SearchHit } from "./api";
import { countLabel, rejectPrompt } from "./changes/changes";
import { useChanges, type Problem } from "./changes/useChanges";
import { ChangesPanel, ChangeView } from "./components/ChangesPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConflictBanner } from "./components/ConflictBanner";
import { Editor } from "./components/Editor";
import { HistoryPanel } from "./components/HistoryPanel";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { resultId, RESULTS_ID, SearchPanel } from "./components/SearchPanel";
import { Sidebar } from "./components/Sidebar";
import { Welcome } from "./components/Welcome";
import { isDirty } from "./doc/docState";
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
  const [docs, setDocs] = useState(props.vault.docs);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<ApiError["code"]>();
  const [active, setActive] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const { state } = doc;
  const searchOpen = query.trim() !== "";

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
    doc.open(path);
  }

  async function approve(paths: string[]) {
    if (await review.approve(paths, message)) setMessage("");
  }

  async function confirmReject() {
    const targets = rejecting ?? [];
    setRejecting(null);
    // Rejecting an added file deletes it; an editor left open on it would recreate it on the next save.
    const deletesOpenDoc = targets.some((c) => c.kind === "added" && c.path === state.path);
    if ((await review.reject(targets.map((c) => c.path))) && deletesOpenDoc) doc.close();
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
              <Sidebar docs={docs} activePath={change ? null : state.path} onOpen={openDoc} />
            ) : (
              <ChangesPanel
                review={review}
                selected={change?.path ?? null}
                message={message}
                onMessage={setMessage}
                onSelect={setSelected}
                onApprove={(paths) => void approve(paths)}
                onReject={setRejecting}
              />
            )}
          </>
        )}
      </aside>
      <main className="main">
        {change && (
          <ChangeView
            key={change.path}
            api={api}
            change={change}
            revision={review.revision}
            busy={review.busy}
            onApprove={() => void approve([change.path])}
            onReject={() => setRejecting([change])}
            onOpenDoc={() => openDoc(change.path)}
            onClose={() => setSelected(null)}
          />
        )}
        {/* Hidden rather than unmounted, so the editor keeps its undo history while a diff is shown. */}
        <div className="docview" hidden={change !== null}>
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
                    {/* Remounting per doc keeps undo history from leaking between files. */}
                    <Editor
                      key={state.path}
                      value={state.draft}
                      onChange={doc.edit}
                      onSave={doc.save}
                      readOnly={state.status === "error" && !dirty}
                    />
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
