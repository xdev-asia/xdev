import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

// Mounted only while open: asks before a key closes a tab or pane with an agent still running.
export function CloseTabsDialog(props: { onConfirm(): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      className="dialog ws-dialog"
      aria-labelledby="ws-close-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="ws-close-title" className="dialog-title">
        {t("panes.closeAgent.title")}
      </h2>
      <p className="dialog-body">{t("panes.closeAgent.body")}</p>
      <div className="dialog-actions">
        {/* Cancel first and focused, so a stray Enter never ends an agent. */}
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <button type="button" className="ws-danger" onClick={props.onConfirm}>
          {t("panes.closeAgent.confirm")}
        </button>
      </div>
    </dialog>
  );
}
