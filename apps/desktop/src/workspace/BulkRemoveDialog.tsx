import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import type { BulkResult } from "./selection";

/** One dialog for deleting or archiving several worktrees. Mounted only while open. */
export function BulkRemoveDialog(props: {
  mode: "delete" | "archive";
  worktrees: WorktreeView[];
  dirty: Record<string, boolean>;
  /** Child paths by parent path, for "with nested". */
  children: Record<string, string[]>;
  busy: boolean;
  result?: BulkResult;
  onConfirm(opts: { anyway: boolean; nested: boolean }): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [anyway, setAnyway] = useState(false);
  const [nested, setNested] = useState(false);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const hasKids = props.worktrees.some((w) => (props.children[w.path] ?? []).length > 0);
  const nameOf = (path: string) => props.worktrees.find((w) => w.path === path)?.name ?? path.split(/[\/]/).pop() ?? path;
  const dirtyCount = props.worktrees.filter((w) => props.dirty[w.path]).length;
  const mode = props.mode;
  const done = props.result !== undefined;
  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-bulk-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!props.busy) props.onCancel();
      }}
    >
      <h2 id="ws-bulk-title" className="dialog-title">
        {t(`bulk.${mode}.title`, { count: props.worktrees.length })}
      </h2>
      <ul className="ws-bulk-list">
        {props.worktrees.map((w) => (
          <li key={w.path} className="ws-bulk-row">
            <span className="ws-wt-name">{w.title ?? w.name}</span>
            <span className="ws-wt-branch">{w.branch ?? t("workspace.detached")}</span>
            {props.dirty[w.path] && <span className="ws-chip">{t("bulk.dirty")}</span>}
          </li>
        ))}
      </ul>
      {!done && dirtyCount > 0 && (
        <label className="ws-tick">
          <input type="checkbox" checked={anyway} disabled={props.busy} onChange={(e) => setAnyway(e.target.checked)} />
          <span>{t(`bulk.${mode}.anyway`, { count: dirtyCount })}</span>
        </label>
      )}
      {!done && hasKids && (
        <label className="ws-tick">
          <input type="checkbox" checked={nested} disabled={props.busy} onChange={(e) => setNested(e.target.checked)} />
          <span>{t("bulk.nested")}</span>
        </label>
      )}
      {!done && hasKids && !nested && <p className="dialog-body">{t("bulk.nested.note")}</p>}
      {props.result && (
        <div role="status">
          <p className="dialog-body">{t("bulk.done", { ok: props.result.ok.length, failed: props.result.failed.length })}</p>
          {props.result.failed.length > 0 && (
            <ul className="ws-bulk-list">
              {props.result.failed.map((f) => (
                <li key={f.path} className="error-text">
                  {nameOf(f.path)}: {t(`error.${f.error.code}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" autoFocus disabled={props.busy} onClick={props.onCancel}>
          {done ? t("dialog.close") : t("dialog.cancel")}
        </button>
        {!done && (
          <button type="button" className="ws-danger" disabled={props.busy} onClick={() => props.onConfirm({ anyway, nested })}>
            {props.busy ? t("workspace.remove.busy") : t(`bulk.${mode}.confirm`, { count: props.worktrees.length })}
          </button>
        )}
      </div>
    </dialog>
  );
}
