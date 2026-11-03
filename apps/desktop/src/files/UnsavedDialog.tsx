import { Button } from "@xdev/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

// Mounted only while open: a dirty file tab is closing. Cancel is focused, so a stray Enter keeps the edits.
export function UnsavedDialog(props: { name: string; onSave(): void; onDiscard(): void; onCancel(): void }): JSX.Element {
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
      aria-labelledby="ws-unsaved-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="ws-unsaved-title" className="dialog-title">
        {t("files.close.title", { name: props.name })}
      </h2>
      <p className="dialog-body">{t("files.close.body")}</p>
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("files.cancel")}
        </button>
        <button type="button" className="ws-danger" onClick={props.onDiscard}>
          {t("files.dontSave")}
        </button>
        <Button type="button" onClick={props.onSave}>
          {t("files.save")}
        </Button>
      </div>
    </dialog>
  );
}
