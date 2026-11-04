import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type CursorStyle, type FontWeight, type OnQuit, type TerminalSettings } from "@/api";
import { useI18n } from "@/i18n";
import { setTerminalSettings, TERMINAL_DEFAULTS, TERMINAL_LIMITS } from "@/terminal/terminalSettings";
import { RunningTerminals } from "./RunningTerminals";
import { SettingGroup, SettingRow, settingShown } from "./SettingRow";
import { TerminalBehaviourSection } from "./terminal/TerminalBehaviourSection";
import { TerminalLookSection } from "./terminal/TerminalLookSection";
import type { SettingsSectionProps } from "./sections";

export const FONT_WEIGHTS: FontWeight[] = ["normal", "medium", "bold"];
export const CURSOR_STYLES: CursorStyle[] = ["block", "bar", "underline"];
// The switches of the Clipboard group, in the order the page lists them.
export const CLIPBOARD_SWITCHES = ["copyOnSelect", "rightClickPaste", "osc52Clipboard"] as const;
const FONT_IDS = ["terminal.fontFamily", "terminal.fontSize", "terminal.fontWeight", "terminal.lineHeight"];
const CURSOR_IDS = ["terminal.cursorStyle", "terminal.cursorBlink"];
export const ON_QUIT: OnQuit[] = ["keep", "end", "ask"];
const SERVICE_IDS = ["terminal.service", "terminal.onQuit", "terminal.ringMb"];
type NumberField = "fontSize" | "lineHeight" | "scrollback" | "ringMb";
type Draft = Partial<Record<NumberField | "fontFamily", string>>;

function without(draft: Draft, field: keyof Draft): Draft {
  const rest = { ...draft };
  delete rest[field];
  return rest;
}

/** Settings → Terminal: font, cursor, buffer and clipboard of every terminal pane. */
export function TerminalPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<TerminalSettings | null>(null);
  // A field while it is being typed in; written when it loses focus or on Enter.
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    api.terminalSettings().then(setSettings, (e) => setError(toApiError(e).code));
  }, [api]);

  const title = (
    <header className="settings-head">
      <h3>{t("settings.terminal.title")}</h3>
      <p>{t("settings.terminal.intro")}</p>
    </header>
  );
  if (!settings) {
    return (
      <div className="settings-page">
        {title}
        {error && (
          <p className="error-text" role="alert">
            {t(`error.${error}`)}
          </p>
        )}
      </div>
    );
  }
  const current = settings;

  // Each write returns what was stored (clamped); the page shows that, not what it asked for.
  async function put(next: TerminalSettings): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setSaveFailed(false);
    try {
      const stored = await api.terminalSettingsPut(next);
      setSettings(stored);
      setDraft({});
      // Open panes read the shared copy, so the change applies without a reload.
      setTerminalSettings(stored);
    } catch (e) {
      setSaveFailed(true);
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  const patch = (change: Partial<TerminalSettings>) => put({ ...current, ...change });

  const typing = (field: keyof Draft, value: string) => setDraft((d) => ({ ...d, [field]: value }));
  function commitText(): void {
    if (draft.fontFamily === undefined || draft.fontFamily === current.fontFamily) return;
    void patch({ fontFamily: draft.fontFamily });
  }
  function commitNumber(field: NumberField): void {
    const raw = draft[field];
    if (raw === undefined) return;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return setDraft((d) => without(d, field));
    const value = field === "lineHeight" ? Math.round(n * 10) / 10 : Math.round(n);
    if (value === current[field]) return setDraft((d) => without(d, field));
    void patch({ [field]: value });
  }
  const numberInput = (field: NumberField, step: number) => (
    <input
      type="number"
      step={step}
      min={TERMINAL_LIMITS[field].min}
      max={TERMINAL_LIMITS[field].max}
      value={draft[field] ?? String(current[field])}
      disabled={busy}
      data-field={field}
      onChange={(e) => typing(field, e.target.value)}
      onBlur={() => commitNumber(field)}
      onKeyDown={(e) => e.key === "Enter" && commitNumber(field)}
    />
  );

  return (
    <div className="settings-page">
      {title}
      {saveFailed && (
        <p className="error-text" role="alert" data-field="save-failed">
          {t("settings.terminal.saveFailed")}
        </p>
      )}

      <SettingGroup ids={FONT_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.terminal.font")}</h4>
      <div className="ws-fields">
        <SettingRow id="terminal.fontFamily" filter={filter}>
        <label className="ws-field">
          <span>{t("settings.terminal.fontFamily")}</span>
          <input
            type="text"
            className="ws-mono"
            value={draft.fontFamily ?? current.fontFamily}
            placeholder="var(--x-font-mono)"
            disabled={busy}
            data-field="fontFamily"
            onChange={(e) => typing("fontFamily", e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => e.key === "Enter" && commitText()}
          />
          <small className="settings-hint">{t("settings.terminal.fontFamilyHint")}</small>
        </label>
        </SettingRow>
        <SettingRow id="terminal.fontSize" filter={filter}>
        <label className="ws-field">
          <span>{t("settings.terminal.fontSize")}</span>
          {numberInput("fontSize", 1)}
        </label>
        </SettingRow>
        <SettingRow id="terminal.fontWeight" filter={filter}>
        <label className="ws-field">
          <span>{t("settings.terminal.fontWeight")}</span>
          <select
            value={current.fontWeight}
            disabled={busy}
            data-field="fontWeight"
            onChange={(e) => void patch({ fontWeight: e.target.value as FontWeight })}
          >
            {FONT_WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {t(`settings.terminal.fontWeight.${w}`)}
              </option>
            ))}
          </select>
        </label>
        </SettingRow>
        <SettingRow id="terminal.lineHeight" filter={filter}>
        <label className="ws-field">
          <span>{t("settings.terminal.lineHeight")}</span>
          {numberInput("lineHeight", 0.1)}
        </label>
        </SettingRow>
      </div>
      <p className="settings-empty">{t("settings.terminal.preview")}</p>
      <pre
        className="term-preview"
        data-field="preview"
        style={{
          fontFamily: current.fontFamily.trim() || "var(--x-font-mono)",
          fontSize: current.fontSize,
          fontWeight: current.fontWeight === "medium" ? 500 : current.fontWeight,
          lineHeight: current.lineHeight,
        }}
      >
        {t("settings.terminal.previewText")}
      </pre>
      </SettingGroup>

      <SettingGroup ids={CURSOR_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.terminal.cursor")}</h4>
      <SettingRow id="terminal.cursorStyle" filter={filter}>
      <div className="ws-fields">
        <div className="ws-field" role="radiogroup" aria-label={t("settings.terminal.cursorStyle")}>
          <span>{t("settings.terminal.cursorStyle")}</span>
          <div className="term-radios">
            {CURSOR_STYLES.map((c) => (
              <label key={c} className="term-radio">
                <input
                  type="radio"
                  name="terminal-cursor-style"
                  value={c}
                  checked={current.cursorStyle === c}
                  disabled={busy}
                  data-cursor={c}
                  onChange={() => void patch({ cursorStyle: c })}
                />
                {t(`settings.terminal.cursorStyle.${c}`)}
              </label>
            ))}
          </div>
        </div>
      </div>
      </SettingRow>
      <ul className="settings-list">
        {settingShown(filter, "terminal.cursorBlink") && (
        <li className="settings-item" data-switch="cursorBlink" data-setting-id="terminal.cursorBlink">
          <div className="settings-item-text">
            <strong>{t("settings.terminal.cursorBlink")}</strong>
          </div>
          <button
            type="button"
            role="switch"
            className="agent-switch"
            aria-checked={current.cursorBlink}
            aria-label={t("settings.terminal.cursorBlink")}
            disabled={busy}
            onClick={() => void patch({ cursorBlink: !current.cursorBlink })}
          />
        </li>
        )}
      </ul>
      </SettingGroup>

      <TerminalLookSection api={api} current={current} busy={busy} patch={patch} filter={filter} />
      <TerminalBehaviourSection current={current} busy={busy} patch={patch} filter={filter} />

      <SettingRow id="terminal.scrollback" filter={filter}>
      <h4 className="settings-group">{t("settings.terminal.buffer")}</h4>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("settings.terminal.scrollback")}</span>
          {numberInput("scrollback", 1000)}
          <small className="settings-hint">{t("settings.terminal.scrollbackHint")}</small>
        </label>
      </div>
      </SettingRow>

      <SettingGroup ids={CLIPBOARD_SWITCHES.map((k) => `terminal.${k}`)} filter={filter}>
      <h4 className="settings-group">{t("settings.terminal.clipboard")}</h4>
      <ul className="settings-list">
        {CLIPBOARD_SWITCHES.map((k) => settingShown(filter, `terminal.${k}`) && (
          <li key={k} className="settings-item" data-switch={k} data-setting-id={`terminal.${k}`}>
            <div className="settings-item-text">
              <strong>{t(`settings.terminal.${k}`)}</strong>
              {k === "osc52Clipboard" && <span className="settings-path">{t("settings.terminal.osc52ClipboardHint")}</span>}
            </div>
            <button
              type="button"
              role="switch"
              className="agent-switch"
              aria-checked={current[k]}
              aria-label={t(`settings.terminal.${k}`)}
              disabled={busy}
              onClick={() => void patch({ [k]: !current[k] })}
            />
          </li>
        ))}
      </ul>
      </SettingGroup>

      <SettingGroup ids={SERVICE_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.terminal.service.group")}</h4>
      <ul className="settings-list">
        {settingShown(filter, "terminal.service") && (
        <li className="settings-item" data-switch="service" data-setting-id="terminal.service">
          <div className="settings-item-text">
            <strong>{t("settings.terminal.service.label")}</strong>
            <span className="settings-path">{t("settings.terminal.service.hint")}</span>
          </div>
          <button
            type="button"
            role="switch"
            className="agent-switch"
            aria-checked={current.service}
            aria-label={t("settings.terminal.service.label")}
            disabled={busy}
            onClick={() => void patch({ service: !current.service })}
          />
        </li>
        )}
      </ul>
      <div className="ws-fields">
        <SettingRow id="terminal.onQuit" filter={filter}>
        <label className="ws-field">
          <span>{t("settings.terminal.service.onQuit")}</span>
          <select
            value={current.onQuit}
            disabled={busy}
            data-field="onQuit"
            onChange={(e) => void patch({ onQuit: e.target.value as OnQuit })}
          >
            {ON_QUIT.map((q) => (
              <option key={q} value={q}>
                {t(`settings.terminal.service.onQuit.${q}`)}
              </option>
            ))}
          </select>
        </label>
        </SettingRow>
        <SettingRow id="terminal.ringMb" filter={filter}>
        <label className="ws-field">
          <span>{t("settings.terminal.service.ringMb")}</span>
          {numberInput("ringMb", 1)}
          <small className="settings-hint">{t("settings.terminal.service.ringMbHint")}</small>
        </label>
        </SettingRow>
      </div>
      </SettingGroup>

      <SettingRow id="terminal.running" filter={filter}>
        <RunningTerminals api={api} />
      </SettingRow>

      <SettingRow id="terminal.reset" filter={filter}>
      <div className="settings-actions settings-actions-start">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void put({ ...TERMINAL_DEFAULTS })}>
          {t("settings.terminal.reset")}
        </button>
      </div>
      </SettingRow>
    </div>
  );
}
