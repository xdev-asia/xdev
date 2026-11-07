import { Button } from "@xdev-asia/ui";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  toApiError,
  type Api,
  type ApiError,
  type Change,
  type DocEntry,
  type Freshness,
  type StaleDoc,
  type VaultView,
} from "@/api";
import { rejectPrompt } from "@/changes/changes";
import { useChanges, type Problem } from "@/changes/useChanges";
import { AgentContext } from "@/components/AgentContext";
import { AgentKitView, type KitHost } from "@/components/AgentKitView";
import { Backlinks } from "@/components/Backlinks";
import { ChangesPanel, ChangeView, ICON, Icon } from "@/components/ChangesPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ConflictBanner } from "@/components/ConflictBanner";
import { Editor } from "@/components/Editor";
import { FreshnessBanner } from "@/components/FreshnessBanner";
import { HistoryPanel } from "@/components/HistoryPanel";
import { NewDocForm } from "@/components/NewDocForm";
import { Preview } from "@/components/Preview";
import { Sidebar } from "@/components/Sidebar";
import { SquadsView } from "@/components/SquadsView";
import { TasksView } from "@/components/TasksView";
import { isDirty } from "@/doc/docState";
import { agentsEditable, parseFrontmatter, setAgents, setVerified } from "@/doc/frontmatter";
import { useDoc } from "@/doc/useDoc";
import { useI18n } from "@/i18n";
import { useKeymap } from "@/keys/keymap";
import { docFileName, newDocContent } from "@/shell/newDoc";

/** What the workspace can ask the docs view to show. */
export type DocsSection = "docs" | "changes" | "context" | "tasks" | "squads" | "kit";

/** Sections that read the docs folder; the others work without one. */
const NEEDS_SOURCE: readonly DocsSection[] = ["docs", "changes", "context"];

export type DocsSaveState = "saved" | "unsaved" | "saving" | "loading" | "conflict";

/** What the footer shows about the open docs. */
export interface DocsStatus {
  dirty: boolean;
  save: DocsSaveState;
  docs: number;
  stale: number;
  /** `null` while the changes are unknown (loading, or the folder is not tracked). */
  changes: number | null;
}

export interface DocsHandle {
  /** Writes pending edits. Resolves `false` when some are left (conflict or a failed write). */
  flush(): Promise<boolean>;
}

export interface DocsViewProps {
  api: Api;
  /** The folder to show; `null` when the project has none and nothing was chosen. */
  source: VaultView | null;
  section: DocsSection;
  kit?: KitHost;
  onStatus?(status: DocsStatus): void;
  onCreateDocs(): void;
  onAddShared(): void;
  /** A view inside asks for another section, e.g. a diff closing back to the doc. */
  onSection?(section: DocsSection): void;
  /** A task to show in Tasks; a new `seq` for the same id shows it again. */
  task?: { id: string; seq: number };
  /** The selected project's primary path, where new tasks and squads go by default. */
  defaultRepo?: string | null;
}

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/** The docs of one folder, with the review, the agent files, tasks and squads beside them. */
export const DocsView = forwardRef<DocsHandle, DocsViewProps>(function DocsView(props, ref) {
  const { source } = props;
  if (source === null) return <Bare {...props} ref={ref} />;
  // Keyed by folder so switching sources starts with a clean editor.
  return <Folder key={source.path} {...props} source={source} ref={ref} />;
});

/** The quieter of the two buttons, in tokens. */
const SECONDARY = {
  background: "var(--x-color-surface)",
  color: "var(--x-color-ink)",
  border: "1px solid var(--x-color-line)",
} as const;

/** No folder: only the sections that need none are usable. */
const Bare = forwardRef<DocsHandle, DocsViewProps>(function Bare(props, ref) {
  const { t } = useI18n();
  useImperativeHandle(ref, () => ({ flush: async () => true }), []);
  useEffect(() => {
    props.onStatus?.({ dirty: false, save: "saved", docs: 0, stale: 0, changes: null });
    // Reported once per folder change; the handler is the host's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (NEEDS_SOURCE.includes(props.section)) {
    return (
      <div className="docsview" data-list="off">
        <div className="docsview-main main">
          <div className="docsview-empty">
            <h2 className="docsview-empty-title">{t("docsview.empty.title")}</h2>
            <p className="docsview-empty-hint">{t("docsview.empty.hint")}</p>
            <div className="docsview-empty-actions">
              <Button variant="primary" type="button" onClick={props.onCreateDocs}>
                {t("docsview.empty.create")}
              </Button>
              <Button variant="primary" type="button" style={SECONDARY} onClick={props.onAddShared}>
                {t("docsview.empty.add")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="docsview" data-list="off">
      <div className="docsview-main main">
        <Standalone {...props} />
      </div>
    </div>
  );
});

/** Tasks, squads and the Agent kit: none reads the docs folder. */
function Standalone(props: DocsViewProps): JSX.Element {
  const { api, section } = props;
  // Set once the Agent kit has been shown; from then on it stays mounted.
  const kitSeen = useRef(false);
  if (section === "kit") kitSeen.current = true;
  // The task a squad link asked Tasks to show; the `task` prop (e.g. from the palette) overrides it.
  const [taskFocus, setTaskFocus] = useState<{ id: string; seq: number } | null>(null);
  const f = props.task ?? taskFocus;
  return (
    <>
      {section === "tasks" && (
        <TasksView
          key={f ? `${f.id}:${f.seq}` : ""}
          api={api}
          initial={f?.id}
          defaultRepo={props.defaultRepo}
        />
      )}
      {section === "squads" && (
        <SquadsView
          api={api}
          defaultRepo={props.defaultRepo}
          onOpenTask={(id) => {
            setTaskFocus((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
            props.onSection?.("tasks");
          }}
        />
      )}
      {/* Hidden rather than unmounted once shown, so an open file or a typed prompt survives. */}
      {kitSeen.current && (
        <div className="kitview" hidden={section !== "kit"}>
          <AgentKitView
            api={api}
            worktree={props.kit?.worktree ?? null}
            request={props.kit?.open}
            onRequestHandled={props.kit?.onOpened}
            onSendToAgent={props.kit?.onSendToAgent}
            canSend={props.kit?.canSend}
            onOpenContext={() => props.onSection?.("context")}
          />
        </div>
      )}
    </>
  );
}

type Opened = { status: "opening" } | { status: "ready" } | { status: "failed"; code: ApiError["code"] };

const Folder = forwardRef<DocsHandle, DocsViewProps & { source: VaultView }>(function Folder(props, ref) {
  const { api, source, section } = props;
  const { t } = useI18n();
  const doc = useDoc(api);
  const review = useChanges(api, doc.flush);
  const [opened, setOpened] = useState<Opened>({ status: "opening" });
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState<Change[] | null>(null);
  // The doc whose history is shown; opening another doc closes the panel without extra bookkeeping.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // One choice for the whole session, so moving between docs keeps reading (or editing) mode.
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [revision, setRevision] = useState(0);
  // Tagged with its path, so a slow answer for the previous doc is never shown on the next one.
  const [freshness, setFreshness] = useState<{ path: string; value: Freshness; now: number }>();
  const [staleDocs, setStaleDocs] = useState<StaleDoc[]>([]);
  // Open while the list shows the new-doc form.
  const [newDoc, setNewDoc] = useState<{ busy: boolean; error?: ApiError["code"] } | null>(null);
  // A doc just created from its title gets the cursor, so typing goes straight below the heading.
  const [typeInto, setTypeInto] = useState<string | null>(null);
  const { state } = doc;
  const loading = state.status === "loading";
  const ready = opened.status === "ready";

  useImperativeHandle(ref, () => ({ flush: doc.flush }), [doc.flush]);

  // The vault is the session's one open folder, so opening it twice (React's StrictMode
  // runs every effect twice in development) would restart its watcher for nothing.
  const openedFor = useRef<{ api: Api; path: string } | null>(null);
  useEffect(() => {
    const last = openedFor.current;
    if (last && last.api === api && last.path === source.path) return;
    openedFor.current = { api, path: source.path };
    // No stale guard: this folder is keyed by its path, and a late answer after unmount sets nothing visible.
    api.openVault(source.path).then(
      (found) => {
        setDocs(found);
        setOpened({ status: "ready" });
      },
      (e: unknown) => setOpened({ status: "failed", code: toApiError(e).code }),
    );
  }, [api, source.path]);

  useEffect(() => {
    const path = state.path;
    if (!ready || path === null || loading) return;
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
  }, [ready, state.path, state.saved, loading, revision, review.revision]);

  useEffect(() => {
    if (!ready) return;
    let stale = false;
    api.staleDocs().then(
      (found) => !stale && setStaleDocs(found),
      () => !stale && setStaleDocs([]),
    );
    return () => {
      stale = true;
    };
  }, [ready, revision, review.revision]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void api
      .onVaultChanged(() => {
        api.listDocs().then(setDocs, () => undefined);
        setRevision((r) => r + 1);
      })
      .then((unlisten) => (disposed ? unlisten() : (off = unlisten)));
    return () => {
      disposed = true;
      off?.();
    };
  }, [api]);

  // The keymap only runs this while the docs view is shown, though the workspace keeps it mounted.
  useKeymap({ "docs.new": () => startNewDoc() });

  useEffect(() => {
    // Approved or rejected (here or in a terminal): there is nothing left to diff, so back to the doc.
    if (selected !== null && review.status === "ok" && !review.changes.some((c) => c.path === selected)) {
      setSelected(null);
    }
  }, [selected, review.status, review.changes]);

  const dirty = isDirty(state);
  const changeCount = review.status === "ok" ? review.changes.length : null;
  const save: DocsSaveState =
    state.status === "conflict"
      ? "conflict"
      : state.status === "loading"
        ? "loading"
        : state.status === "saving"
          ? "saving"
          : dirty
            ? "unsaved"
            : "saved";
  const onStatus = props.onStatus;
  useEffect(() => {
    onStatus?.({ dirty, save, docs: docs.length, stale: staleDocs.length, changes: changeCount });
    // The host's handler may change every render; only the values decide when to report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, save, docs.length, staleDocs.length, changeCount]);

  function openDoc(path: string) {
    setTypeInto(null);
    setSelected(null);
    props.onSection?.("docs");
    doc.open(path);
  }

  function startNewDoc() {
    props.onSection?.("docs");
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
  const prompt = rejecting && rejecting.length > 0 ? rejectPrompt(rejecting) : null;
  const entry = docs.find((d) => d.path === state.path);
  const docPaths = useMemo(() => docs.map((d) => d.path), [docs]);
  const forAgents = useMemo(() => parseFrontmatter(state.draft).fm.agents.length > 0, [state.draft]);
  const agentsLocked = !agentsEditable(state.draft);
  const readOnly = state.status === "error" && !dirty;
  const tracked = review.status === "ok";
  const historyPath = tracked && historyFor === state.path && !loading ? historyFor : null;
  const historyOpen = historyPath !== null;
  const hasList = section === "docs" || section === "changes";
  const saveLabel = t(`docsview.save.${save}`);

  if (opened.status !== "ready" && NEEDS_SOURCE.includes(section)) {
    return (
      <div className="docsview" data-list="off">
        <div className="docsview-main main">
          {opened.status === "opening" ? (
            <p className="placeholder" role="status">
              {t("vault.opening")}
            </p>
          ) : (
            <p className="placeholder error-text" role="alert">
              {t("vault.empty.failed", { path: source.path })} {t(`error.${opened.code}`)}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="docsview" data-list={hasList ? undefined : "off"} title={source.path}>
      {hasList && (
        <aside className="docsview-list sidebar">
          {section === "docs" ? (
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
            <ChangesPanel
              review={review}
              selected={change?.path ?? null}
              message={message}
              onMessage={setMessage}
              onSelect={setSelected}
              onApprove={(changes) => void approve(changes)}
              onReject={setRejecting}
            />
          )}
        </aside>
      )}
      <main className="docsview-main main">
        <Standalone {...props} />
        {section === "context" && (
          <>
            {source.kind === "shared" && <p className="docsview-note">{t("docsview.sharedNote")}</p>}
            <AgentContext
              api={api}
              revision={revision}
              flush={doc.flush}
              vaultPath={source.path}
              onOpenDoc={openDoc}
            />
          </>
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
            onClose={() => props.onSection?.("docs")}
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
        {/* Hidden rather than unmounted, so the editor keeps its undo history while a diff is shown. */}
        <div className="docview" hidden={section !== "docs"}>
          {state.path === null ? (
            <p className="placeholder">{t("docsview.placeholder")}</p>
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
                      disabled={agentsLocked || readOnly || loading}
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
                      disabled={loading}
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
              {loading ? (
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
});
