import { Button } from "@xdev-asia/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { ApiError } from "@/api";
import { useI18n } from "@/i18n";
import { LanguageSwitch } from "./LanguageSwitch";

export function CreateVaultDialog(props: {
  open: boolean;
  path: string;
  busy: boolean;
  error?: ApiError["code"];
  onPath(path: string): void;
  onPick(): void;
  onCreate(): void;
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

  const empty = props.path.trim() === "";
  return (
    <dialog
      ref={dialog}
      className="dialog vault-dialog"
      aria-labelledby="vault-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!props.busy) props.onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!empty && !props.busy) props.onCreate();
        }}
      >
        {/* The dialog is modal, so the top bar's switch cannot be reached while it is open. */}
        <div className="vault-dialog-head">
          <h2 id="vault-dialog-title" className="dialog-title">
            {t("vault.create.title")}
          </h2>
          <LanguageSwitch />
        </div>
        <p className="dialog-body">{t("vault.create.body")}</p>
        <label className="vault-dialog-path">
          <span>{t("vault.create.path")}</span>
          <input
            type="text"
            value={props.path}
            spellCheck={false}
            disabled={props.busy}
            onChange={(e) => props.onPath(e.target.value)}
          />
        </label>
        <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onPick}>
          {t("vault.create.pick")}
        </button>
        {props.error && (
          <p className="error-text" role="alert">
            {t(`error.${props.error}`)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onCancel}>
            {t("vault.create.later")}
          </button>
          <Button type="submit" disabled={empty || props.busy}>
            {props.busy ? t("vault.create.busy") : t("vault.create.confirm")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
