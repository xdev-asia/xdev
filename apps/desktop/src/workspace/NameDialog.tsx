import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { ApiError } from "@/api";
import { useI18n } from "@/i18n";

/** A one-field dialog for a group name. Enter saves; an empty name cannot be saved. Mounted only while open. */
export function NameDialog(props: { heading: string; label: string; initial: string; error?: ApiError["code"]; onSave(name: string): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(props.initial);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const name = text.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name) props.onSave(name);
  };
  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-name-heading"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <form onSubmit={submit}>
        <h2 id="ws-name-heading" className="dialog-title">
          {props.heading}
        </h2>
        <label className="ws-title-field">
          <span>{props.label}</span>
          <input type="text" autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </label>
        {props.error && (
          <p className="error-text" role="alert">
            {t(`error.${props.error}`)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={props.onCancel}>
            {t("dialog.cancel")}
          </button>
          <Button variant="primary" type="submit" disabled={!name}>
            {t("dialog.save")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
