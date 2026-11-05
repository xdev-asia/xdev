import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import type { HelpLink } from "@/api";
import { useI18n } from "@/i18n";

// Mounted only while open.
export function AboutDialog(props: { version: string; onLink(link: HelpLink): void; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="about-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <h2 id="about-title" className="dialog-title">
        {t("shell.help.about")}
      </h2>
      <p className="dialog-body">{t("shell.help.aboutVersion", { version: props.version })}</p>
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={() => props.onLink("docs")}>
          {t("shell.help.docs")}
        </button>
        <button type="button" className="btn-secondary" onClick={() => props.onLink("source")}>
          {t("shell.help.source")}
        </button>
        <Button type="button" autoFocus onClick={props.onClose}>
          {t("shell.help.close")}
        </Button>
      </div>
    </dialog>
  );
}
