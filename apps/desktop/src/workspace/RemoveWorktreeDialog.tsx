import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ApiError, WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import { showsDontAsk } from "./deleteFlow";

// Mounted only while open. `dirty` turns the confirm into the forced delete.
export function RemoveWorktreeDialog(props: {
  worktree: WorktreeView;
  /** The repo's base ref, where a branch made here must be merged to go too. */
  base: string;
  dirty: boolean;
  busy: boolean;
  /** The archive script is running; it can take a while, so Cancel stays usable. */
  archiving?: boolean;
  /** The archive script ended with a failure; the person may remove anyway. */
  failed?: { code: number | null; output: string };
  error?: ApiError["code"];
  /** How many worktrees name this one as their parent. */
  children?: number;
  /** The nested tick starts on (the row menu's "Delete with nested worktrees"). */
  nestedDefault?: boolean;
  /** Ticked "Don't ask again" on a confirmed delete; without it the tick is left out. */
  onDontAsk?(skip: boolean): void;
  /** `nested`: the children go too. */
  onConfirm(nested: boolean): void;
  /** Archive instead of delete: the folder goes, the branch stays. */
  onArchive?(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [nested, setNested] = useState(props.nestedDefault === true);
  const [skip, setSkip] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const wt = props.worktree;
  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-remove-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!props.busy || props.archiving) props.onCancel();
      }}
    >
      <h2 id="ws-remove-title" className="dialog-title">
        {t("workspace.remove.title", { name: wt.name })}
      </h2>
      <p className="dialog-body">{t("workspace.remove.body")}</p>
      <dl className="ws-facts">
        <dt>{t("workspace.remove.folder")}</dt>
        <dd className="ws-mono">{wt.path}</dd>
        <dt>{t("workspace.remove.branch")}</dt>
        <dd className="ws-mono">{wt.branch ?? t("workspace.detached")}</dd>
      </dl>
      {wt.branch && props.base && !props.dirty && <p className="dialog-body">{t("workspace.remove.branchNote", { base: props.base })}</p>}
      {props.dirty && (
        <>
          <p className="error-text" role="alert">
            {t("error.worktree_dirty")}
          </p>
          <p className="dialog-body">{t("workspace.remove.forceNote")}</p>
        </>
      )}
      {(props.children ?? 0) > 0 && (
        <label className="ws-tick">
          <input type="checkbox" checked={nested} disabled={props.busy} onChange={(e) => setNested(e.target.checked)} />
          <span>{t("workspace.remove.nested")}</span>
        </label>
      )}
      {props.onDontAsk && showsDontAsk({ dirty: props.dirty, children: props.children ?? 0, count: 1 }) && (
        <label className="ws-tick">
          <input type="checkbox" data-dont-ask checked={skip} disabled={props.busy} onChange={(e) => setSkip(e.target.checked)} />
          <span>{t("workspace.remove.dontAsk")}</span>
        </label>
      )}
      {props.archiving && (
        <p className="dialog-body" role="status">
          {t("workspace.remove.archiving")}
        </p>
      )}
      {props.failed && (
        <>
          <p className="error-text" role="alert">
            {props.failed.code === null ? t("workspace.remove.archiveFailedNoCode") : t("workspace.remove.archiveFailed", { code: props.failed.code })}
          </p>
          <pre className="ws-mono ws-script" tabIndex={0}>{props.failed.output}</pre>
        </>
      )}
      {props.error && (
        <p className="error-text" role="alert">
          {t(`error.${props.error}`)}
        </p>
      )}
      <div className="dialog-actions">
        {/* Cancel first and focused, so a stray Enter never deletes anything. */}
        <button type="button" className="btn-secondary" autoFocus disabled={props.busy && !props.archiving} onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        {props.onArchive && !props.failed && (
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onArchive}>
            {t("workspace.remove.archiveInstead")}
          </button>
        )}
        <button type="button" className="ws-danger" disabled={props.busy} onClick={() => {
            if (skip) props.onDontAsk?.(true);
            props.onConfirm(nested);
          }}>
          {props.busy ? t("workspace.remove.busy") : props.failed ? t("workspace.remove.anyway") : props.dirty ? t("workspace.remove.force") : t("workspace.remove.confirm")}
        </button>
      </div>
    </dialog>
  );
}
