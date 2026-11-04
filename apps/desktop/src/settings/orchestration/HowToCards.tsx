import { ActionTile, Button } from "@xdev-asia/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { HOW_TO, promptText, type HowToId } from "./howTo";

/** Five tiles; one opens a dialog with the prompt to paste into an agent. */
export function HowToCards(props: { open: HowToId | null; copied: boolean; onOpen(id: HowToId): void; onClose(): void; onCopy(text: string): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <div className="x-action-tiles" data-howto="tiles">
        {HOW_TO.map((c) => (
          <ActionTile
            key={c.id}
            icon={c.icon}
            title={t(`settings.orchestration.howTo.${c.id}.title`)}
            description={t(`settings.orchestration.howTo.${c.id}.summary`)}
            onClick={() => props.onOpen(c.id)}
          />
        ))}
      </div>
      {props.open && <HowToDialog id={props.open} copied={props.copied} onClose={props.onClose} onCopy={props.onCopy} />}
    </>
  );
}

// Mounted only while open (the TrustDialog pattern): title, summary, the read-only prompt, Copy prompt, Done.
export function HowToDialog(props: { id: HowToId; copied: boolean; onClose(): void; onCopy(text: string): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  const prompt = promptText(t(`settings.orchestration.howTo.${props.id}.prompt`));
  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="orch-howto-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <h2 id="orch-howto-title" className="dialog-title">
        {t(`settings.orchestration.howTo.${props.id}.title`)}
      </h2>
      <p className="dialog-body">{t(`settings.orchestration.howTo.${props.id}.summary`)}</p>
      <pre className="ws-mono ws-script orch-prompt" tabIndex={0} data-howto="prompt">
        {prompt}
      </pre>
      <div className="dialog-actions">
        <Button type="button" variant="secondary" data-act="done" onClick={props.onClose}>
          {t("settings.orchestration.howTo.done")}
        </Button>
        <Button type="button" data-act="copy-prompt" onClick={() => props.onCopy(prompt)}>
          {props.copied ? t("settings.orchestration.howTo.copied") : t("settings.orchestration.howTo.copyPrompt")}
        </Button>
      </div>
    </dialog>
  );
}
