import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import type { QuitAsk, QuitChoice } from "./quitGuard";

// Mounted only while open: "On quit: Ask" with terminals still running in the service.
export function QuitDialog(props: { ask: QuitAsk; onChoose(choice: QuitChoice): void }): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const { ask, onChoose } = props;

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
      aria-labelledby="ptyd-quit-title"
      onCancel={(e) => {
        e.preventDefault();
        onChoose("cancel");
      }}
    >
      <h2 id="ptyd-quit-title" className="dialog-title">
        {t("ptyd.quit.title")}
      </h2>
      <p className="dialog-body">{t("ptyd.quit.body", { count: ask.count })}</p>
      {ask.working.length > 0 && (
        <>
          <p className="dialog-body">{t("ptyd.quit.working")}</p>
          <ul className="dialog-body">
            {ask.working.map((w) => (
              <li key={w.id}>{w.title}</li>
            ))}
          </ul>
        </>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={() => onChoose("cancel")}>
          {t("dialog.cancel")}
        </button>
        <button type="button" className="ws-danger" onClick={() => onChoose("end")}>
          {t("ptyd.quit.end")}
        </button>
        {/* Keep running is the safe answer: focused, so Enter never ends an agent. */}
        <Button variant="primary" type="button" autoFocus onClick={() => onChoose("keep")}>
          {t("ptyd.quit.keep")}
        </Button>
      </div>
    </dialog>
  );
}
