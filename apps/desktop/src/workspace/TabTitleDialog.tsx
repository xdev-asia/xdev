import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useI18n } from "@/i18n";

/** What Save stores: the trimmed text, or null (back to the program's title) when it is empty. */
export function titleToSave(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/**
 * Change Title…: a text field prefilled with the current title, Reset to program title, Save and Cancel.
 * Enter saves; an empty title saves as a reset. Mounted only while open.
 */
export function TabTitleDialog(props: { title: string; onSave(title: string | null): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(props.title);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onSave(titleToSave(text));
  };

  return (
    <dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      className="dialog ws-dialog"
      aria-labelledby="ws-title-heading"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <form onSubmit={submit}>
        <h2 id="ws-title-heading" className="dialog-title">
          {t("tabMenu.title.heading")}
        </h2>
        <label className="ws-title-field">
          <span>{t("tabMenu.title.field")}</span>
          <input type="text" autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn-secondary ws-title-reset" onClick={() => props.onSave(null)}>
            {t("tabMenu.title.reset")}
          </button>
          <button type="button" className="btn-secondary" onClick={props.onCancel}>
            {t("tabMenu.title.cancel")}
          </button>
          <Button variant="primary" type="submit">{t("tabMenu.title.save")}</Button>
        </div>
      </form>
    </dialog>
  );
}
