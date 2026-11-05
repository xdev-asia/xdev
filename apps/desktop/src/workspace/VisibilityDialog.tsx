import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { Button, Switch } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import type { VisibilityRow } from "./worktreeVisibility";

/**
 * Which worktrees the sidebar lists: the ones made outside xDev and the ones hidden from a row menu,
 * each with a switch, and Restore all. Mounted only while open.
 */
export function VisibilityDialog(props: {
  rows: VisibilityRow[];
  /** Outside worktrees stay out of the sidebar until shown. */
  defaultHidden: boolean;
  onDefaultHidden(on: boolean): void;
  onToggle(row: VisibilityRow, shown: boolean): void;
  onRestoreAll(): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  const many = new Set(props.rows.map((r) => r.repoId)).size > 1;
  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-visibility-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <h2 id="ws-visibility-title" className="dialog-title">
        {t("visibility.title")}
      </h2>
      <p className="dialog-body">{t("visibility.hint")}</p>
      <Switch label={t("visibility.defaultHidden")} checked={props.defaultHidden} onChange={(e) => props.onDefaultHidden(e.target.checked)} />
      {props.rows.length === 0 ? (
        <p className="ws-empty">{t("visibility.empty")}</p>
      ) : (
        <ul className="ws-visibility-list">
          {props.rows.map((row) => (
            <li key={row.path} className="ws-visibility-row" title={row.path}>
              <span className="ws-found-text">
                <span className="ws-wt-name">{row.name}</span>
                <span className="ws-wt-branch">{[many ? row.repoName : null, row.branch ?? t("workspace.detached")].filter(Boolean).join(" · ")}</span>
              </span>
              {row.external && <span className="ws-chip">{t("visibility.external")}</span>}
              <Switch aria-label={t("visibility.showLabel", { name: row.name })} checked={row.visible} onChange={(e) => props.onToggle(row, e.target.checked)} />
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <Button variant="secondary" disabled={props.rows.every((r) => r.visible)} onClick={props.onRestoreAll}>
          {t("visibility.restoreAll")}
        </Button>
        <Button autoFocus onClick={props.onClose}>
          {t("dialog.close")}
        </Button>
      </div>
    </dialog>
  );
}
