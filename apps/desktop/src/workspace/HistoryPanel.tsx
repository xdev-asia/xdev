import { CommitGraph, Disclosure, IconButton, SplitHandle, Tag, Tooltip, graphRows } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type CommitFiles, type RepoLog } from "@/api";
import { useI18n } from "@/i18n";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { clampHistoryHeight, historyRows, HISTORY_HEIGHT, rememberOpen, type HistoryRow } from "./gitHistory";
import { pushToast } from "./toastStore";

const PAGE = 50;
const SHORT = 7;

// Open or closed, per worktree, for the length of the app run.
let remembered: ReadonlyMap<string, boolean> = new Map();
export function isHistoryOpen(worktree: string): boolean {
  return remembered.get(worktree) ?? false;
}
export function setHistoryOpen(worktree: string, open: boolean): void {
  remembered = rememberOpen(remembered, worktree, open);
}

type Files = { loading: boolean; error: ApiError | null; data: CommitFiles | null };
const LETTER: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechange: "T" };

/**
 * The commits of one worktree as a graph, at the foot of Source Control. Closed it reads nothing;
 * open it loads the newest fifty and again when the worktree, the base or `reloadKey` changes.
 */
export function HistoryPanel(props: {
  api: Api;
  worktree: string;
  // The repo's base ref; a change reloads the graph.
  base?: string;
  // Changes after a ship action, so the graph reads again.
  reloadKey?: number;
  // False while the panel is not on screen: nothing is read then.
  visible?: boolean;
  onOpenCommit(id: string, file: string | null): void;
}): JSX.Element {
  const { api, worktree } = props;
  const { t, locale } = useI18n();
  const [open, setOpenState] = useState(() => isHistoryOpen(worktree));
  const [height, setHeight] = useState<number>(HISTORY_HEIGHT.initial);
  const [log, setLog] = useState<RepoLog | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, Files>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; subject: string; message: string } | null>(null);
  // Only the newest read may write.
  const reads = useRef(0);
  const visible = props.visible ?? true;

  function setOpen(next: boolean): void {
    setHistoryOpen(worktree, next);
    setOpenState(next);
  }

  async function load(): Promise<void> {
    const seq = ++reads.current;
    setLoading(true);
    try {
      const next = await api.worktreeLog(worktree, PAGE, 0);
      if (seq === reads.current) {
        setLog(next);
        setError(null);
      }
    } catch (e) {
      if (seq === reads.current) setError(toApiError(e));
    } finally {
      if (seq === reads.current) setLoading(false);
    }
  }

  useEffect(() => {
    setOpenState(isHistoryOpen(worktree));
    setLog(null);
    setShown(null);
    setFiles({});
  }, [worktree]);

  useEffect(() => {
    if (!open || !visible) return;
    void load();
    return () => {
      reads.current++;
    };
  }, [api, worktree, props.base, props.reloadKey, open, visible, tick]);

  async function showFiles(id: string): Promise<void> {
    if (shown === id) {
      setShown(null);
      return;
    }
    setShown(id);
    if (files[id]?.data) return;
    setFiles((f) => ({ ...f, [id]: { loading: true, error: null, data: null } }));
    try {
      const data = await api.worktreeCommitFiles(worktree, id);
      setFiles((f) => ({ ...f, [id]: { loading: false, error: null, data } }));
    } catch (e) {
      setFiles((f) => ({ ...f, [id]: { loading: false, error: toApiError(e), data: null } }));
    }
  }

  async function copy(what: "hash" | "message", text: string): Promise<void> {
    const name = t(`gitHistory.what.${what}`);
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ id: `history-copy:${what}`, text: t("gitHistory.copied", { what: name }) });
    } catch {
      pushToast({ id: `history-copy:${what}`, text: t("gitHistory.copyFailed", { what: name }) });
    }
  }

  async function openInBrowser(id: string): Promise<void> {
    try {
      await api.worktreeOpenCommit(worktree, id);
    } catch (e) {
      const code = toApiError(e).code;
      pushToast({ id: "history-open", text: t(code === "no_web_remote" ? "gitHistory.noWebRemote" : "gitHistory.openFailed") });
    }
  }

  const rows = log ? historyRows(log) : [];
  const graph = log
    ? graphRows(
        rows.map((r) => ({ id: r.key, parents: r.parents, refIds: r.marks, boundary: r.boundary !== null })),
        { head: log.head ?? undefined, remote: log.upstream?.id, base: log.base?.id },
      )
    : [];
  const clamped = clampHistoryHeight(height, typeof window !== "undefined" && "innerHeight" in window ? window.innerHeight : 1000);
  const date = (time: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "long" }).format(new Date(time * 1000));

  const menuItems = (m: NonNullable<typeof menu>): MenuItem[] => [
    { id: "open", labelKey: "gitHistory.menu.open", run: () => void openInBrowser(m.id) },
    { id: "hash", labelKey: "gitHistory.menu.copyHash", run: () => void copy("hash", m.id) },
    { id: "message", labelKey: "gitHistory.menu.copyMessage", run: () => void copy("message", m.message) },
  ];

  function row(r: HistoryRow, i: number): JSX.Element {
    const cell = graph[i] && <CommitGraph row={graph[i]} />;
    const tags = (
      <>
        {r.tags.map((ref) => (
          <Tag key={`${ref.kind}:${ref.name}`}>{ref.name}</Tag>
        ))}
        {r.overflow.length > 0 && (
          <span className="ws-history-more" title={r.overflow.join(", ")}>
            {t("gitHistory.more", { count: r.overflow.length })}
          </span>
        )}
      </>
    );
    if (r.boundary !== null || r.commit === null) {
      return (
        <li key={r.key} className="ws-history-row" data-boundary={r.boundary ?? undefined}>
          <div className="ws-history-line">
            {cell}
            <span className="ws-history-subject">{t(`gitHistory.${r.boundary}`)}</span>
          </div>
        </li>
      );
    }
    const commit = r.commit;
    const expanded = shown === commit.id;
    const label = t(expanded ? "gitHistory.row.hide" : "gitHistory.row.show", { id: commit.id.slice(0, SHORT), subject: r.subject });
    const detail = files[commit.id];
    const message = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
    return (
      <li key={r.key} className="ws-history-row" data-expanded={expanded ? "" : undefined}>
        <button
          type="button"
          className="ws-history-line"
          aria-label={label}
          aria-expanded={expanded}
          title={message}
          onClick={() => void showFiles(commit.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, id: commit.id, subject: r.subject, message });
          }}
        >
          {cell}
          <span className="ws-history-subject">{r.subject}</span>
          {tags}
        </button>
        {expanded && (
          <div className="ws-history-detail">
            <span className="ws-history-meta">{t("gitHistory.meta", { author: commit.author, date: date(commit.time) })}</span>
            {(detail === undefined || detail.loading) && <span className="ws-history-note">{t("gitHistory.files.loading")}</span>}
            {detail?.error && <span className="error-text">{t(`error.${detail.error.code}`)}</span>}
            {detail?.data && detail.data.files.length === 0 && <span className="ws-history-note">{t("gitHistory.files.none")}</span>}
            {detail?.data && detail.data.files.length > 0 && (
              <>
                {detail.data.files.map((f) => {
                  const slash = f.path.lastIndexOf("/");
                  return (
                    <button key={f.path} type="button" className="ws-history-file" onClick={() => props.onOpenCommit(commit.id, f.path)}>
                      <span className="ws-history-fname">{slash < 0 ? f.path : f.path.slice(slash + 1)}</span>
                      {slash >= 0 && <span className="ws-history-dir">{f.path.slice(0, slash)}</span>}
                      <span className="ws-history-letter" data-status={f.status}>{LETTER[f.status] ?? "M"}</span>
                    </button>
                  );
                })}
                <button type="button" className="ws-ship-link" onClick={() => props.onOpenCommit(commit.id, null)}>
                  {t("gitHistory.openAll")}
                </button>
              </>
            )}
          </div>
        )}
      </li>
    );
  }

  const count = log ? log.commits.length : 0;
  return (
    <>
      <Disclosure
        className="ws-history"
        title={t("gitHistory.title")}
        expanded={open}
        onToggle={setOpen}
        actions={
          <>
            <Tooltip content={t("gitHistory.help")}>
              <IconButton icon="help" label={t("gitHistory.helpLabel")} />
            </Tooltip>
            <IconButton
              icon="restore"
              label={t("gitHistory.refresh")}
              onClick={() => (open ? setTick((n) => n + 1) : setOpen(true))}
            />
          </>
        }
      >
        {open && (
          <div className="ws-history-body" style={{ height: clamped }}>
            {log && (
              <span className="ws-history-count">
                {count}
                {log.hasMore ? "+" : ""}
              </span>
            )}
            {error && <p className="error-text" role="alert">{t(`error.${error.code}`)}</p>}
            {!error && loading && !log && <p className="ws-history-note">{t("gitHistory.loading")}</p>}
            {!error && log && rows.length === 0 && <p className="ws-history-note">{t("gitHistory.empty")}</p>}
            {rows.length > 0 && <ul className="ws-history-list">{rows.map(row)}</ul>}
          </div>
        )}
      </Disclosure>
      {open && (
        <SplitHandle
          direction="vertical"
          value={clamped}
          min={HISTORY_HEIGHT.min}
          max={HISTORY_HEIGHT.max}
          step={HISTORY_HEIGHT.step}
          reverse
          label={t("gitHistory.resize")}
          onResize={setHeight}
        />
      )}
      {menu && <ContextMenu at={menu} items={menuItems(menu)} onClose={() => setMenu(null)} />}
    </>
  );
}
