import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import {
  api as defaultApi,
  toApiError,
  type Api,
  type ApiError,
  type Change,
  type DocEntry,
  type Freshness,
  type SearchHit,
  type StaleDoc,
} from "@/api";
import { rejectPrompt } from "@/changes/changes";
import { useChanges, type Problem } from "@/changes/useChanges";
import { AgentContext } from "@/components/AgentContext";
import { Backlinks } from "@/components/Backlinks";
import { ChangesPanel, ChangeView, ICON, Icon } from "@/components/ChangesPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ConflictBanner } from "@/components/ConflictBanner";
import { CreateVaultDialog } from "@/components/CreateVaultDialog";
import { Editor } from "@/components/Editor";
import { FreshnessBanner } from "@/components/FreshnessBanner";
import { HistoryPanel } from "@/components/HistoryPanel";
import { NewDocForm } from "@/components/NewDocForm";
import { Preview } from "@/components/Preview";
import { resultId, RESULTS_ID, SearchPanel } from "@/components/SearchPanel";
import { Sidebar } from "@/components/Sidebar";
import { isDirty } from "@/doc/docState";
import { agentsEditable, parseFrontmatter, setAgents, setVerified } from "@/doc/frontmatter";
import { useDoc } from "@/doc/useDoc";
import { useI18n } from "@/i18n";
import { useKeymap } from "@/keys/keymap";
import { docFileName, newDocContent } from "@/shell/newDoc";
import type { DocsSection } from "@/shell/places";
import { setUpVault } from "@/shell/setUpVault";
import type { DocsRequest } from "@/shell/useShellViews";
import { DOCS_SEARCH_ID } from "./ids";
import type { DocsHandle, DocsSaveState, DocsStatus } from "./types";
import { VaultEmpty, type VaultFailure } from "./VaultEmpty";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 50;
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K";

// `open` is a doc to show first, e.g. the starter doc of a folder just created.
type Vault = { path: string; docs: DocEntry[]; open?: string };

/** What the host tells the shell: the footer status plus which folder it is. */
export type DocsHostStatus = DocsStatus & { folder: string | null; path: string | null };

export type DocsHostProps = {
  api?: Api;
  /** The shell side list the host draws its navigation into; `null` until the slot exists. */
  navSlot: HTMLElement | null;
  /** The shell asks for a section; a new `seq` asks again. */
  request: DocsRequest | null;
  onStatus(status: DocsHostStatus): void;
  /** The host moved to another section by itself, e.g. a diff closing back to the doc. */
  onOpenSection?(section: DocsSection): void;
  /** The folder sources, drawn at the top of the side list. */
  vaultNav?: ReactNode;
  ref?: Ref<DocsHandle>;
};

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

const NO_FOLDER: DocsHostStatus = { dirty: false, save: "saved", docs: 0, stale: 0, changes: null, folder: null, path: null };

/** Docs: the vault, its docs and the agents that work on them. It draws no chrome of its own. */
export function DocsHost(props: DocsHostProps): JSX.Element {
  const { t } = useI18n();
  const api = props.api ?? defaultApi;
  // The flush of the open vault's editor; a host with no folder has nothing to save.
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  useImperativeHandle(props.ref, () => ({ flush: () => flushRef.current() }), []);
  const [booting, setBooting] = useState(true);
  const [vault, setVault] = useState<Vault | null>(null);
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<VaultFailure>();
  const [defaultPath, setDefaultPath] = useState("");
  // The create dialog: closed, or open with the path being edited and the last error.
  const [creating, setCreating] = useState<{ path: string; error?: ApiError["code"] } | null>(null);
  const booted = useRef(false);
  const onStatus = props.onStatus;

  const openVault = useCallback(
    async (path: string) => {
      setOpening(true);
      try {
        setVault({ path, docs: await api.openVault(path) });
        setFailure(undefined);
      } catch (e) {
        setFailure({ path, code: toApiError(e).code });
      } finally {
        setOpening(false);
      }
    },
    [api],
  );

  const pickAndOpen = useCallback(async () => {
    const path = await api.pickFolder().catch(() => null);
    if (path) await openVault(path);
  }, [api, openVault]);

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
  }, [api, openVault]);

  // Without a folder the footer has no docs to count. A folder reports its own status.
  useEffect(() => {
    if (!vault) onStatus(NO_FOLDER);
    // The shell's handler may change every render; only the folder decides when to report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault === null]);

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
        <VaultView
          key={vault.path}
          api={api}
          vault={vault}
          flushRef={flushRef}
          navSlot={props.navSlot}
          vaultNav={props.vaultNav}
          request={props.request}
          onStatus={onStatus}
          onOpenSection={props.onOpenSection}
          onChangeFolder={pickAndOpen}
        />
      ) : (
        <>
          {props.navSlot && createPortal(props.vaultNav ?? null, props.navSlot)}
          <VaultEmpty failure={failure} busy={opening} onCreate={() => setCreating({ path: defaultPath })} onOpen={() => void pickAndOpen()} />
        </>
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

type VaultViewProps = {
  api: Api;
  vault: Vault;
  flushRef: { current: () => Promise<boolean> };
  navSlot: HTMLElement | null;
  vaultNav?: ReactNode;
  request: DocsRequest | null;
  onStatus(status: DocsHostStatus): void;
  onOpenSection?(section: DocsSection): void;
  onChangeFolder(): Promise<void>;
};

export function VaultView(props: VaultViewProps): JSX.Element {
  const { t } = useI18n();
  const { api } = props;
  const doc = useDoc(api);
  const review = useChanges(api, doc.flush);
  const [section, setSection] = useState<DocsSection>("docs");
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
  // Tagged with its path, so a slow answer for the previous doc is never shown on the next one.
  const [freshness, setFreshness] = useState<{ path: string; value: Freshness; now: number }>();
  const [staleDocs, setStaleDocs] = useState<StaleDoc[]>([]);
  // Open while the side list shows the new-doc form.
  const [newDoc, setNewDoc] = useState<{ busy: boolean; error?: ApiError["code"] } | null>(null);
  // A doc just created from its title gets the cursor, so typing goes straight below the heading.
  const [typeInto, setTypeInto] = useState<string | null>(null);
  const { state } = doc;
  const searchOpen = query.trim() !== "";
  const loading = state.status === "loading";

  // The shell asks for the editor's flush before it switches the folder.
  const { flushRef } = props;
  flushRef.current = doc.flush;
  useEffect(
    () => () => {
      flushRef.current = async () => true;
    },
    [flushRef],
  );

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
  }, [api, state.path, state.saved, loading, revision, review.revision]);

  useEffect(() => {
    let stale = false;
    api.staleDocs().then(
      (found) => !stale && setStaleDocs(found),
      () => !stale && setStaleDocs([]),
    );
    return () => {
      stale = true;
    };
  }, [api, revision, review.revision]);

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
  }, [api]);

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
  }, [api, query, revision]);

  // The keymap only runs this while the docs view is shown, though the shell keeps it mounted.
  // `docs.search` belongs to the side list, which owns the field.
  useKeymap({
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
    setSection("docs");
    doc.open(path);
  }

  function startNewDoc() {
    setQuery("");
    setSection("docs");
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

  function openSection(next: DocsSection) {
    // A diff belongs to Changes; elsewhere the stage goes back to the open doc.
    if (next !== "changes") setSelected(null);
    // Picking a section is a request for its list, which search results would otherwise cover.
    setQuery("");
    setSection(next);
  }

  // A request from the shell shows the section it names.
  const requestSeq = props.request?.seq;
  useEffect(() => {
    if (props.request) openSection(props.request.section);
    // Only a new request runs this; `openSection` just sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSeq]);

  function goTo(next: DocsSection) {
    openSection(next);
    props.onOpenSection?.(next);
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
    review.changes.find((c) => c.path === selected) ?? (section === "changes" ? (review.changes[0] ?? null) : null);
  const changeCount = review.status === "ok" ? review.changes.length : null;
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
  const save: DocsSaveState =
    state.status === "conflict" ? "conflict" : state.status === "loading" ? "loading" : state.status === "saving" ? "saving" : dirty ? "unsaved" : "saved";

  const { onStatus } = props;
  const folder = folderName(props.vault.path);
  useEffect(() => {
    onStatus({ dirty, save, docs: docs.length, stale: staleDocs.length, changes: changeCount, folder, path: props.vault.path });
    // The shell's handler may change every render; only the values decide when to report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, save, docs.length, staleDocs.length, changeCount, folder]);

  const list =
    searchOpen ? (
      <SearchPanel query={query} hits={hits} searching={searching} error={searchError} activeIndex={active} onOpen={openDoc} />
    ) : section === "docs" ? (
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
    ) : section === "changes" ? (
      <ChangesPanel
        review={review}
        selected={change?.path ?? null}
        message={message}
        onMessage={setMessage}
        onSelect={setSelected}
        onApprove={(changes) => void approve(changes)}
        onReject={setRejecting}
      />
    ) : null;

  return (
    <>
      {props.navSlot &&
        createPortal(
          <>
            {props.vaultNav}
            <div className="docs-nav-fields">
              <input
                id={DOCS_SEARCH_ID}
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
              <button type="button" className="btn-secondary" onClick={changeFolder} disabled={state.status === "conflict"}>
                {t("vault.change")}
              </button>
            </div>
            {list}
          </>,
          props.navSlot,
        )}
      <div className="docs-stage">
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
            onClose={() => goTo("docs")}
          />
        )}
        {section === "changes" && !change && review.status === "ok" && (
          <div className="placeholder changes-empty">
            <span className="changes-empty-icon">
              <Icon d={ICON.check} size={28} />
            </span>
            <p>{t("changes.empty.main")}</p>
          </div>
        )}
        {section === "agents" && (
          <AgentContext api={api} revision={revision} flush={doc.flush} vaultPath={props.vault.path} onOpenDoc={openDoc} />
        )}
        {/* Hidden rather than unmounted, so the editor keeps its undo history while a diff is shown. */}
        <div className="docview" hidden={section !== "docs"}>
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
      </div>
      <ConfirmDialog
        open={prompt !== null}
        title={prompt ? t(prompt.key, prompt.vars) : ""}
        body={t("changes.reject.body")}
        confirmLabel={t("changes.reject")}
        onConfirm={() => void confirmReject()}
        onCancel={() => setRejecting(null)}
      />
    </>
  );
}
