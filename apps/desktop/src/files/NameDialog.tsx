import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { checkName } from "./nameCheck";

/** Asks for one entry name (New file, New folder, Rename); Enter or the button confirms a good name. */
export function NameDialog(props: {
  title: string;
  initial?: string;
  /** The names already in the folder; the entry being renamed is not among them. */
  siblings: readonly string[];
  confirmLabel: string;
  onConfirm(name: string): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(props.initial ?? "");
  const [touched, setTouched] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);
  const problem = checkName(name, props.siblings);
  const message = problem && touched ? t(`files.name.${problem}`, { name }) : "";
  const submit = () => {
    setTouched(true);
    if (!problem) props.onConfirm(name);
  };
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="name-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="name-dialog-title" className="dialog-title">{props.title}</h2>
      <input
        className="dialog-input"
        data-field="name"
        aria-label={t("files.name.label")}
        aria-invalid={message !== ""}
        value={name}
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
          setTouched(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <p className="dialog-warn" role="alert">{message}</p>
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={props.onCancel}>{t("files.cancel")}</button>
        <Button type="button" onClick={submit}>{props.confirmLabel}</Button>
      </div>
    </dialog>
  );
}
