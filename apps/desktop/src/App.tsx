import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, toApiError, type ApiError, type DocEntry, type SearchHit } from "./api";
import { ConflictBanner } from "./components/ConflictBanner";
import { Editor } from "./components/Editor";
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

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(Math.max(i + step, 0), Math.max(hits.length - 1, 0)));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      doc.open(hits[active].path);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  }

  function changeFolder() {
    // Flush pending edits to the current vault before the session can switch away.
    doc.save();
    void props.onChangeFolder();
  }

  const entry = docs.find((d) => d.path === state.path);
  const dirty = isDirty(state);
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
            onOpen={doc.open}
          />
        ) : (
          <Sidebar docs={docs} activePath={state.path} onOpen={doc.open} />
        )}
      </aside>
      <main className="main">
        {state.path === null ? (
          <p className="placeholder">{t("editor.placeholder", { shortcut: SHORTCUT })}</p>
        ) : (
          <>
            <div className="doc-head">
              <div className="doc-titles">
                <h1 className="doc-title">{entry?.title ?? folderName(state.path)}</h1>
                <span className="doc-path">{state.path}</span>
              </div>
              <span className="doc-status" data-dirty={dirty || undefined} aria-live="polite">
                {saveLabel}
              </span>
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
              // Remounting per doc keeps undo history from leaking between files.
              <Editor
                key={state.path}
                value={state.draft}
                onChange={doc.edit}
                onSave={doc.save}
                readOnly={state.status === "error" && !dirty}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
