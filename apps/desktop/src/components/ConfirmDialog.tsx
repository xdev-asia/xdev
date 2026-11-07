import { Button } from "@xdev-asia/ui";
import { useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { useI18n } from "@/i18n";

// A native modal dialog: focus trapping, Escape and the backdrop come from the browser.
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  /** An extra line in red under the body, for a choice that carries a risk. */
  warning?: string;
  /** Extra controls between the warning and the buttons, such as an option checkbox. */
  children?: ReactNode;
  confirmLabel: string;
  /** The title's id. Dialogs mounted side by side on one page give their own, or the first one names them all. */
  titleId?: string;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = props.titleId ?? "dialog-title";

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
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Escape: let React state close it, so `open` stays the single source of truth.
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {props.title}
      </h2>
      <p className="dialog-body">{props.body}</p>
      {props.warning && <p className="dialog-warn">{props.warning}</p>}
      {props.children}
      <div className="dialog-actions">
        {/* Cancel first and focused, so a stray Enter never discards work. */}
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <Button variant="primary" type="button" onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
