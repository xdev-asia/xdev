import { Button } from "@xdev-asia/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { OnNameTaken, SchemePreview } from "@/api";
import { useI18n } from "@/i18n";
import { ANSI_KEYS } from "./ansiKeys";

/** What went wrong reading the file: an `ApiError` code, and for `theme_invalid` the field. */
export type ImportError = { code: string; detail?: string };

/** The import step of Settings → Terminal: the colours of the chosen file and what to do about it. */
export function ImportSchemeDialog(props: {
  open: boolean;
  /** `null` when the file could not be read; `error` says why. */
  preview: SchemePreview | null;
  error?: ImportError;
  busy: boolean;
  onImport(onTaken: OnNameTaken): void;
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

  const { preview, error, busy } = props;
  const taken = preview?.nameTaken === true;
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="import-scheme-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onCancel();
      }}
    >
      <h2 id="import-scheme-title" className="dialog-title">
        {t("settings.terminal.import.title")}
      </h2>
      {preview && (
        <>
          <p className="dialog-body" data-field="import-name">
            {preview.scheme.name}
          </p>
          <div className="term-swatches" role="img" aria-label={t("settings.terminal.theme.swatches")}>
            {ANSI_KEYS.map((k) => (
              <span key={k} className="term-swatch" data-swatch={k} style={{ background: preview.scheme.colors[k] }} />
            ))}
          </div>
          {preview.lowContrast && (
            <p className="settings-hint" role="status" data-field="low-contrast">
              {t("settings.terminal.import.lowContrast")}
            </p>
          )}
          {preview.ignoredKeys.length > 0 && (
            <p className="settings-hint" data-field="ignored">
              {t("settings.terminal.import.ignored", { keys: preview.ignoredKeys.join(", ") })}
            </p>
          )}
          {taken && (
            <p className="settings-hint" role="status" data-field="taken">
              {t("settings.terminal.import.taken", { name: preview.scheme.name })}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="error-text" role="alert" data-field="import-error">
          {t(`error.${error.code}`)}
          {error.detail ? ` (${error.detail})` : ""}
        </p>
      )}
      <div className="dialog-actions">
        <Button type="button" variant="secondary" data-action="cancel" disabled={busy} onClick={props.onCancel}>
          {t("settings.terminal.import.cancel")}
        </Button>
        {preview && taken && (
          <>
            <Button type="button" variant="secondary" data-action="replace" disabled={busy} onClick={() => props.onImport("replace")}>
              {t("settings.terminal.import.replace")}
            </Button>
            <Button type="button" data-action="keepBoth" disabled={busy} onClick={() => props.onImport("keepBoth")}>
              {t("settings.terminal.import.keepBoth")}
            </Button>
          </>
        )}
        {preview && !taken && (
          <Button variant="primary" type="button" data-action="import" disabled={busy} onClick={() => props.onImport("fail")}>
            {t("settings.terminal.import.confirm")}
          </Button>
        )}
      </div>
    </dialog>
  );
}
