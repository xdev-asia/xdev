import { Button } from "@xdev/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "../i18n";

// A native modal dialog: focus trapping, Escape and the backdrop come from the browser.
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        // Escape: let React state close it, so `open` stays the single source of truth.
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="dialog-title" className="dialog-title">
        {props.title}
      </h2>
      <p className="dialog-body">{props.body}</p>
      <div className="dialog-actions">
        {/* Cancel first and focused, so a stray Enter never discards work. */}
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <Button type="button" onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
