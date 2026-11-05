import { useState } from "react";
import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import { toApiError, type Api, type ApiError, type ImportPreview } from "@/api";
import { useI18n } from "@/i18n";
import { CONFIG_EXTENSIONS, CONFIG_SECTIONS, applicable, defaultChosen, fileName, nothingToImport, toggle } from "./configSections";

/** Settings → Advanced: export chosen sections to a JSON file without secrets, and import one with a preview. */
export function ConfigIo({ api, onApplied }: { api: Api; onApplied?: () => void }): JSX.Element {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string[]>([...CONFIG_SECTIONS]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<ApiError["code"]>();
  const [file, setFile] = useState<{ path: string; preview: ImportPreview } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);

  const fail = (e: unknown): void => setError(toApiError(e).code);

  async function exportNow(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      const out = await api.configExport(picked);
      if (out) setStatus(t("settings.config.export.done", { name: fileName(out.path), count: String(out.sections.length) }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function openFile(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      const path = await api.pickFile(CONFIG_EXTENSIONS);
      if (!path) return;
      const preview = await api.configImportPreview(path);
      setFile({ path, preview });
      setChosen(defaultChosen(preview));
    } catch (e) {
      setFile(null);
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const out = await api.configImportApply(file.path, chosen);
      setStatus(t("settings.config.import.done", { count: String(out.applied.length) }));
      setFile(null);
      onApplied?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="config-io">
      <fieldset className="config-sections" disabled={busy}>
        <legend>{t("settings.config.export")}</legend>
        <small className="settings-hint">{t("settings.config.export.hint")}</small>
        {CONFIG_SECTIONS.map((name) => (
          <label key={name} className="ws-tick">
            <input
              type="checkbox"
              name="exportSection"
              value={name}
              checked={picked.includes(name)}
              onChange={() => setPicked((all) => (all.includes(name) ? all.filter((n) => n !== name) : [...all, name]))}
            />
            <span className="ws-tick-text">{t(`settings.config.section.${name}`)}</span>
          </label>
        ))}
      </fieldset>
      <div className="settings-actions settings-actions-start">
        <Button type="button" variant="secondary" data-act="export-settings" disabled={busy || picked.length === 0} onClick={() => void exportNow()}>
          {t("settings.config.export")}
        </Button>
        <Button type="button" variant="secondary" data-act="import-settings" disabled={busy} onClick={() => void openFile()}>
          {t("settings.config.import")}
        </Button>
      </div>
      <small className="settings-hint">{t("settings.config.import.hint")}</small>
      <span role="status" className="settings-hint">
        {status}
      </span>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      {file && (
        <section className="config-preview-box" aria-label={t("settings.config.preview", { name: fileName(file.path) })}>
          <strong>{t("settings.config.preview", { name: fileName(file.path) })}</strong>
          {nothingToImport(file.preview) && <p className="settings-hint">{t("settings.config.preview.none")}</p>}
          <ul className="config-preview">
            {file.preview.sections.map((s) => (
              <li key={s.section} data-import-section={s.section}>
                <label className="ws-tick">
                  <input
                    type="checkbox"
                    name="importSection"
                    value={s.section}
                    checked={chosen.includes(s.section)}
                    disabled={busy || !applicable(s)}
                    onChange={() => file && setChosen(toggle(file.preview, chosen, s.section))}
                  />
                  <span className="ws-tick-text">
                    {t(`settings.config.section.${s.section}`)}
                    {s.invalid
                      ? ` — ${t("settings.config.preview.invalid")}`
                      : s.changes.length === 0
                        ? ` — ${t("settings.config.preview.same")}`
                        : ` — ${t("settings.config.preview.changes", { count: String(s.changes.length) })}`}
                  </span>
                </label>
                {s.changes.length > 0 && (
                  <ul className="config-preview ws-mono">
                    {s.changes.map((c) => (
                      <li key={c.path}>
                        {c.path || s.section}: {c.from || "∅"} → {c.to || "∅"}
                      </li>
                    ))}
                  </ul>
                )}
                {s.unknown.length > 0 && (
                  <small className="settings-hint">{t("settings.config.preview.unknown", { keys: s.unknown.join(", ") })}</small>
                )}
                {s.secretsRemoved > 0 && (
                  <small className="settings-hint">{t("settings.config.preview.secrets", { count: String(s.secretsRemoved) })}</small>
                )}
              </li>
            ))}
          </ul>
          {file.preview.unknownSections.length > 0 && (
            <small className="settings-hint">{t("settings.config.preview.unknownSections", { names: file.preview.unknownSections.join(", ") })}</small>
          )}
          <div className="settings-actions settings-actions-start">
            <Button type="button" variant="secondary" data-act="apply-import" disabled={busy || chosen.length === 0} onClick={() => void apply()}>
              {t("settings.config.import.apply")}
            </Button>
            <Button type="button" variant="secondary" data-act="cancel-import" disabled={busy} onClick={() => setFile(null)}>
              {t("settings.config.import.cancel")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
