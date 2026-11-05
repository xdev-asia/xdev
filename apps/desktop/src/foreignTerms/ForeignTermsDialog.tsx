import { Banner, Button, Dialog, EmptyState, IconButton, ListRow, Tag } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ForeignScan, type ForeignTerm, type SessionRow } from "@/api";
import { useI18n } from "@/i18n";
import { copyText } from "@/ui/clipboard";
import { ago } from "@/workspace/ago";
import "./foreignTerms.css";

export interface ForeignTermsDialogProps {
  api: Pick<Api, "foreignTermsScan" | "agentSessions">;
  onClose(): void;
  /** Adds the folder as a project. */
  onOpenFolder(path: string): void;
  /** Resumes the session in a new agent tab of its worktree. */
  onResume(row: SessionRow): void;
  now?: () => number;
}

type Load = { kind: "loading" } | { kind: "done"; scan: ForeignScan } | { kind: "failed"; code: string };

/** Terminals and agent CLIs that xDev did not start: copy a pid, open a folder, resume a known session. */
export function ForeignTermsDialog({ api, onClose, onOpenFolder, onResume, now = Date.now }: ForeignTermsDialogProps): JSX.Element {
  const { t } = useI18n();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [note, setNote] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    api
      .foreignTermsScan()
      .then((scan) => live && setLoad({ kind: "done", scan }))
      .catch((e: unknown) => live && setLoad({ kind: "failed", code: toApiError(e).code }));
    return () => {
      live = false;
    };
  }, [api, seq]);

  function refresh(): void {
    setNote(null);
    setSeq((n) => n + 1);
  }

  async function copyPid(row: ForeignTerm): Promise<void> {
    const ok = await copyText(String(row.pid));
    setNote(t(ok ? "foreignTerms.copied" : "foreignTerms.copyFailed", { pid: row.pid }));
  }

  async function resume(row: ForeignTerm): Promise<void> {
    const s = row.session;
    if (!s) return;
    setNote(null);
    let found: SessionRow | undefined;
    try {
      const rows = await api.agentSessions({ text: s.id, scope: { kind: "all" }, agent: s.agent, homeId: s.homeId, sort: "lastDesc", limit: 5 }, false);
      found = rows.find((r) => r.session.key === s.key);
    } catch {
      // Said below, the same as a session the index has lost.
    }
    if (!found?.worktree || !found.resumable) {
      setNote(t("foreignTerms.resumeMissing"));
      return;
    }
    onResume(found);
  }

  const status =
    note ??
    (load.kind === "loading"
      ? t("foreignTerms.loading")
      : load.kind === "failed"
        ? ""
        : load.scan.truncated
          ? t("foreignTerms.truncated", { count: load.scan.rows.length })
          : t("foreignTerms.count", { count: load.scan.rows.length }));

  function item(row: ForeignTerm): JSX.Element {
    const title = row.agentTitle ?? row.name;
    const meta = [
      row.parentApp,
      row.cwd,
      row.startMs !== null ? t("foreignTerms.started", { ago: ago(row.startMs, now(), t) }) : null,
      t("foreignTerms.pid", { pid: row.pid }),
    ]
      .filter((x): x is string => !!x)
      .join(" · ");
    return (
      <li key={row.pid} className="ft-item" aria-label={t("foreignTerms.rowLabel", { name: title, pid: row.pid })}>
        <ListRow
          title={
            <span className="ft-title">
              {title}
              {row.agent ? <Tag>{t("foreignTerms.agent")}</Tag> : null}
            </span>
          }
          meta={<span className="ft-meta">{meta}</span>}
          trailing={
            <IconButton icon="copy" label={t("foreignTerms.copyPid", { pid: row.pid })} onClick={() => void copyPid(row)} />
          }
        />
        {(row.cwd && row.cwdIsDir) || row.session ? (
          <div className="ft-actions">
            {row.cwd && row.cwdIsDir ? (
              <Button variant="secondary" aria-label={t("foreignTerms.openFolderLabel", { path: row.cwd })} onClick={() => onOpenFolder(row.cwd!)}>
                {t("foreignTerms.openFolder")}
              </Button>
            ) : null}
            {row.session ? (
              <Button variant="secondary" aria-label={t("foreignTerms.resumeLabel", { name: title })} onClick={() => void resume(row)}>
                {t("foreignTerms.resume")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <Dialog modal size="wide" title={t("foreignTerms.title")} confirmLabel={t("foreignTerms.close")} cancelLabel={null} onConfirm={onClose} onCancel={onClose} body="plain">
      <div className="ft-body">
        <div className="ft-head">
          <p className="ft-status" role="status">
            {status}
          </p>
          <Button variant="secondary" icon="refresh" disabled={load.kind === "loading"} onClick={refresh}>
            {t("foreignTerms.refresh")}
          </Button>
        </div>
        <p className="ft-hint">{t("foreignTerms.hint")}</p>
        {load.kind === "failed" ? (
          <Banner title={t("foreignTerms.failed")}>{t(load.code === "timeout" ? "foreignTerms.failed.timeout" : "foreignTerms.failed.other")}</Banner>
        ) : load.kind === "done" && load.scan.rows.length === 0 ? (
          <EmptyState title={t("foreignTerms.empty")} hint={t("foreignTerms.emptyHint")} />
        ) : load.kind === "done" ? (
          <ul className="ft-list" aria-label={t("foreignTerms.title")}>
            {load.scan.rows.map(item)}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}
