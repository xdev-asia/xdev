import { useEffect, useState } from "react";
import type { JSX } from "react";
import { FontField, UI_FONT_SUGGESTIONS } from "@xdev-asia/ui";
import { toApiError, type ApiError, type EditorSettings } from "@/api";
import { clampEditorSettings, EDITOR_LIMITS } from "@/files/editorDefaults";
import { getEditorSettings, setEditorSettings } from "@/files/editorSettings";
import { useI18n } from "@/i18n";
import { getTerminalSettings } from "@/terminal/terminalSettings";
import { SettingRow, settingShown } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

type NumberField = "autosaveMs" | "fontSize" | "tabSize";
const NUMBER_STEP: Record<NumberField, number> = { autosaveMs: 250, fontSize: 1, tabSize: 1 };

/** Settings → Editor: autosave, font size, word wrap and tab size of the file editor. */
export function EditorPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<EditorSettings>(getEditorSettings);
  // A number while it is being typed in; written when it loses focus or on Enter.
  const [draft, setDraft] = useState<Partial<Record<NumberField, string>>>({});
  // The family while it is being typed in; written on Enter or when the field loses focus.
  const [fontDraft, setFontDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    api.editorSettings().then(setSettings, (e) => setError(toApiError(e).code));
  }, [api]);

  // Each write returns what was stored (clamped); the page and the open editors show that.
  async function put(next: EditorSettings): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const stored = await api.editorSettingsPut(clampEditorSettings(next));
      setSettings(stored);
      setDraft({});
      setFontDraft(undefined);
      setEditorSettings(stored);
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  const patch = (change: Partial<EditorSettings>) => put({ ...settings, ...change });

  function commit(field: NumberField): void {
    const raw = draft[field];
    if (raw === undefined) return;
    const n = Number(raw);
    const drop = () => setDraft((d) => ({ ...d, [field]: undefined }));
    if (raw.trim() === "" || !Number.isFinite(n)) return drop();
    const value = clampEditorSettings({ ...settings, [field]: n })[field];
    if (value === settings[field]) return drop();
    void patch({ [field]: value });
  }
  function saveFont(): void {
    if (fontDraft === undefined) return;
    const family = fontDraft.trim();
    setFontDraft(undefined);
    if (family !== settings.fontFamily) void patch({ fontFamily: family });
  }
  const numberInput = (field: NumberField) => (
    <input
      type="number"
      step={NUMBER_STEP[field]}
      min={EDITOR_LIMITS[field].min}
      max={EDITOR_LIMITS[field].max}
      value={draft[field] ?? String(settings[field])}
      disabled={busy}
      data-field={field}
      onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
      onBlur={() => commit(field)}
      onKeyDown={(e) => e.key === "Enter" && commit(field)}
    />
  );
  const toggle = (key: "autosave" | "wordWrap", label: string, hint?: string) => settingShown(filter, `editor.${key}`) && (
    <li className="settings-item" data-switch={key} data-setting-id={`editor.${key}`}>
      <div className="settings-item-text">
        <strong>{label}</strong>
        {hint && <span className="settings-path">{hint}</span>}
      </div>
      <button
        type="button"
        role="switch"
        className="agent-switch"
        aria-checked={settings[key]}
        aria-label={label}
        disabled={busy}
        onClick={() => void patch({ [key]: !settings[key] })}
      />
    </li>
  );

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("files.settings.title")}</h3>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <ul className="settings-list">
        {toggle("autosave", t("files.settings.autosave"), t("files.settings.autosaveHint"))}
        {toggle("wordWrap", t("files.settings.wordWrap"))}
      </ul>
      <div className="ws-fields">
        <SettingRow id="editor.autosaveMs" filter={filter}>
          <label className="ws-field">
            <span>{t("files.settings.autosaveMs")}</span>
            {numberInput("autosaveMs")}
          </label>
        </SettingRow>
        <SettingRow id="editor.fontSize" filter={filter}>
          <label className="ws-field">
            <span>{t("files.settings.fontSize")}</span>
            {numberInput("fontSize")}
          </label>
        </SettingRow>
        <SettingRow id="editor.fontFamily" filter={filter}>
          <div className="ws-field" data-field="fontFamily">
            <span>{t("files.settings.fontFamily")}</span>
            <FontField
              value={fontDraft ?? settings.fontFamily}
              suggestions={UI_FONT_SUGGESTIONS}
              placeholder={getTerminalSettings().fontFamily.trim() || "var(--x-font-mono)"}
              aria-label={t("files.settings.fontFamily")}
              disabled={busy}
              labels={{ reset: t("files.settings.fontFamily.reset") }}
              onChange={(next) => {
                setFontDraft(next);
                // Clearing goes back to the terminal font at once; typing waits for Enter or leaving the field.
                if (next === "" && settings.fontFamily !== "") void patch({ fontFamily: "" });
              }}
              onBlur={saveFont}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveFont();
              }}
            />
            <small className="settings-hint">{t("files.settings.fontFamily.hint")}</small>
          </div>
        </SettingRow>
        <SettingRow id="editor.tabSize" filter={filter}>
          <label className="ws-field">
            <span>{t("files.settings.tabSize")}</span>
            {numberInput("tabSize")}
            <small className="settings-hint">{t("files.settings.tabSizeHint")}</small>
          </label>
        </SettingRow>
      </div>
    </div>
  );
}
