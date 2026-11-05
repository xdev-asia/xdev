import { Button } from "@xdev-asia/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { ConfigKind, TermConfigDetected, TermConfigPreview } from "@/api";
import { useI18n } from "@/i18n";
import { ANSI_KEYS } from "./ansiKeys";
import type { ConfigRow, ConfigRowId } from "./importConfig";
import type { ImportError } from "./ImportSchemeDialog";

const KINDS: ConfigKind[] = ["ghostty", "kitty"];

/** Settings → Terminal: import a Ghostty or Kitty config. Pick a config, see what changes, apply the checked part. */
export function ImportConfigDialog(props: {
  open: boolean;
  detected: TermConfigDetected | null;
  /** The config being previewed; `null` before one is picked. */
  kind: ConfigKind | null;
  preview: TermConfigPreview | null;
  rows: ConfigRow[];
  checked: ReadonlySet<ConfigRowId>;
  error?: ImportError;
  busy: boolean;
  onPick(kind: ConfigKind): void;
  onChooseFile(kind: ConfigKind): void;
  onToggle(id: ConfigRowId): void;
  onApply(): void;
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

  const { detected, kind, preview, rows, checked, error, busy } = props;
  const show = (v: string | boolean | null): string =>
    v === null ? t("settings.terminal.importConfig.none") : typeof v === "boolean" ? t(v ? "settings.terminal.importConfig.on" : "settings.terminal.importConfig.off") : v;
  const nothing = preview !== null && rows.length === 0;
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="import-config-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onCancel();
      }}
    >
      <h2 id="import-config-title" className="dialog-title">
        {t("settings.terminal.importConfig.title")}
      </h2>
      <div className="ws-fields" data-field="config-kinds">
        {KINDS.map((k) => {
          const path = detected?.[k] ?? null;
          return (
            <div key={k} className="ws-field">
              <span>{t(`settings.terminal.importConfig.kind.${k}`)}</span>
              <Button type="button" variant="secondary" data-action={`pick-${k}`} disabled={busy || path === null} onClick={() => props.onPick(k)}>
                {t("settings.terminal.importConfig.useDetected")}
              </Button>
              <Button type="button" variant="secondary" data-action={`file-${k}`} disabled={busy} onClick={() => props.onChooseFile(k)}>
                {t("settings.terminal.importConfig.chooseFile")}
              </Button>
              {path === null && <small className="settings-hint">{t("settings.terminal.importConfig.notFound")}</small>}
            </div>
          );
        })}
      </div>
      {preview && kind && (
        <>
          <p className="dialog-body" data-field="config-path">
            {t(`settings.terminal.importConfig.kind.${kind}`)}: {preview.path}
          </p>
          {nothing ? (
            <p className="settings-hint" role="status" data-field="nothing">
              {t("settings.terminal.importConfig.nothing")}
            </p>
          ) : (
            <ul className="settings-list" data-field="config-rows">
              {rows.map((r) => (
                <li key={r.id} className="settings-item" data-row={r.id}>
                  <label className="settings-item-text">
                    <input type="checkbox" checked={checked.has(r.id)} disabled={busy} data-check={r.id} onChange={() => props.onToggle(r.id)} />{" "}
                    <strong>{t(`settings.terminal.importConfig.row.${r.id}`)}</strong>
                    <small className="settings-hint">
                      {show(r.from)} {"→"} {show(r.to)}
                    </small>
                    {r.id === "colors" && preview.scheme && (
                      <span className="term-swatches" role="img" aria-label={t("settings.terminal.theme.swatches")}>
                        {ANSI_KEYS.map((k) => (
                          <span key={k} className="term-swatch" data-swatch={k} style={{ background: preview.scheme!.colors[k] }} />
                        ))}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {preview.themeName && (
            <p className="settings-hint" data-field="theme-name">
              {t("settings.terminal.importConfig.themeName", { name: preview.themeName })}
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
        {preview && !nothing && (
          <Button type="button" data-action="apply" disabled={busy || checked.size === 0} onClick={props.onApply}>
            {t("settings.terminal.importConfig.apply")}
          </Button>
        )}
      </div>
    </dialog>
  );
}
