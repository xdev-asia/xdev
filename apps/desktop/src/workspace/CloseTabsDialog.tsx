import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

// Mounted only while open: asks before a close that ends a running agent or a pinned tab.
export function CloseTabsDialog(props: { reason?: "running" | "pinned"; onConfirm(): void; onCancel(): void }): JSX.Element {
  const key = props.reason === "pinned" ? "panes.closePinned" : "panes.closeAgent";
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
        {t(`${key}.title`)}
      </h2>
      <p className="dialog-body">{t(`${key}.body`)}</p>
      <div className="dialog-actions">
        {/* Cancel first and focused, so a stray Enter never ends an agent. */}
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <button type="button" className="ws-danger" onClick={props.onConfirm}>
          {t(`${key}.confirm`)}
        </button>
      </div>
    </dialog>
  );
}
