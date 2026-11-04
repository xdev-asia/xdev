import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ApiError, KeptBranch, KeptView } from "@/api";
import { useI18n } from "@/i18n";
import { ago } from "./ago";

/** Lists the branches xDev kept; each can be deleted (an unmerged one needs a second tick) or kept. */
export function ReviewBranchesDialog(props: {
  kept: KeptView[];
  busy: boolean;
  error?: ApiError["code"];
  now?: number;
  onDelete(entry: KeptBranch, unmergedOk: boolean): void;
  onKeep(entry: KeptBranch): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-review-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <h2 id="ws-review-title" className="dialog-title">
        {t("review.title", { count: props.kept.length })}
      </h2>
      {props.kept.length === 0 && <p className="dialog-body">{t("review.empty")}</p>}
      <ul className="ws-bulk-list">
        {props.kept.map(({ entry, ahead }) => {
          const ok = ticked.includes(entry.branch);
          return (
            <li key={entry.branch} className="ws-bulk-row" data-branch={entry.branch}>
              <span className="ws-wt-name">{entry.title ?? entry.branch}</span>
              <span className="ws-wt-branch">
                {entry.branch} · {t(entry.reason === "archived" ? "review.archived" : "review.deleted")} · {ago(entry.keptMs, props.now ?? Date.now(), t)}
              </span>
              {ahead > 0 && (
                <label className="ws-tick">
                  <input type="checkbox" checked={ok} onChange={(e) => setTicked(e.target.checked ? [...ticked, entry.branch] : ticked.filter((b) => b !== entry.branch))} />
                  <span>{t("review.unmerged", { count: ahead })}</span>
                </label>
              )}
              <button type="button" className="btn-secondary" disabled={props.busy} onClick={() => props.onKeep(entry)}>
                {t("review.keep")}
              </button>
              <button type="button" className="ws-danger" disabled={props.busy || (ahead > 0 && !ok)} onClick={() => props.onDelete(entry, ahead > 0 && ok)}>
                {t("review.delete")}
              </button>
            </li>
          );
        })}
      </ul>
      {props.error && (
        <p className="error-text" role="alert">
          {t(`error.${props.error}`)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" autoFocus onClick={props.onClose}>
          {t("dialog.close")}
        </button>
      </div>
    </dialog>
  );
}
