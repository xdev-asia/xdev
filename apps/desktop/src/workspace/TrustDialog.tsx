import { Button } from "@xdev/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { ApiError, HookKind } from "@/api";
import { useI18n } from "@/i18n";

// Mounted only while open. Shows the exact text of a shared script from the repo file: trust covers
// that text, and the person has to see it first.
export function TrustDialog(props: {
  repo: string;
  /** The repo file the script comes from. */
  file: string;
  kind: HookKind;
  text: string;
  /** The dialog reopened because the script changed after it was last shown. */
  changed: boolean;
  busy: boolean;
  error?: ApiError["code"];
  onTrust(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-trust-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="ws-trust-title" className="dialog-title">
        {t("setup.trust.title", { kind: t(`setup.kind.${props.kind}`) })}
      </h2>
      <p className="dialog-body">{t("setup.trust.body", { repo: props.repo, file: props.file })}</p>
      {props.changed && <p className="dialog-body">{t("setup.trust.changed")}</p>}
      <pre className="ws-mono ws-script" tabIndex={0}>{props.text}</pre>
      <p className="dialog-body">{t("setup.trust.note")}</p>
      {props.error && (
        <p className="error-text" role="alert">
          {t(`error.${props.error}`)}
        </p>
      )}
      <div className="dialog-actions">
        {/* Cancel first and focused: trusting is a deliberate click. */}
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <Button type="button" disabled={props.busy} onClick={props.onTrust}>
          {t("setup.trust.confirm")}
        </Button>
      </div>
    </dialog>
  );
}
