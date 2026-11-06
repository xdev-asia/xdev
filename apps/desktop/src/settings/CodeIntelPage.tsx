import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Button, Select, StatusDot, Switch, type StatusTone } from "@xdev-asia/ui";
import { toApiError, type ApiError, type LspLanguage, type LspRunning, type LspServerInfo, type LspSettings } from "@/api";
import { useI18n } from "@/i18n";
import "@/styles/codeIntel.css";
import { SettingGroup, SettingRow, settingShown } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

export const LSP_LANGUAGES: readonly LspLanguage[] = ["typescript", "rust", "python", "go", "csharp"];
const IDLE_CHOICES = [5, 10, 30, 60];
const LANGUAGE_IDS = LSP_LANGUAGES.map((l) => `code.lang.${l}`);

/** Settings → Code intelligence: which language servers run, when they stop, and the repos trusted to start them. */
export function CodeIntelPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<LspSettings | null>(null);
  const [servers, setServers] = useState<LspServerInfo[]>([]);
  const [running, setRunning] = useState<LspRunning[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const [forgot, setForgot] = useState<number | null>(null);

  useEffect(() => {
    const fail = (e: unknown) => setError(toApiError(e).code);
    api.lspSettingsGet().then(setSettings, fail);
    api.lspServers(false).then(setServers, fail);
    api.lspStatus().then(setRunning, fail);
  }, [api]);

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  // The server rows say enabled and running as the backend counts them, so they reload after each write.
  const put = (next: LspSettings) =>
    run(async () => {
      setSettings(await api.lspSettingsPut(next));
      setServers(await api.lspServers(false));
      setRunning(await api.lspStatus());
    });
  const lookAgain = () =>
    run(async () => {
      setServers(await api.lspServers(true));
      setRunning(await api.lspStatus());
    });
  const forget = () =>
    run(async () => {
      if (!settings) return;
      const count = settings.trusted.length;
      setSettings(await api.lspSettingsPut({ ...settings, trusted: [] }));
      setForgot(count);
    });

  const languageLabel = (l: LspLanguage) => t(`settings.code.lang.${l}`);
  const off = !settings || !settings.enabled;

  function row(server: LspServerInfo): JSX.Element | null {
    const { language } = server;
    if (!settingShown(filter, `code.lang.${language}`)) return null;
    const crashed = running.some((r) => r.language === language && r.state === "crashed");
    const tone: StatusTone = crashed ? "danger" : server.path ? "ok" : "neutral";
    const on = !!settings && !settings.disabled.includes(language);
    return (
      <li key={language} className="settings-item code-intel-row" data-setting-id={`code.lang.${language}`} data-language={language}>
        <div className="code-intel-text">
          <strong>{languageLabel(language)}</strong>
          <span className="settings-path code-intel-status" data-field="status">
            <StatusDot
              tone={tone}
              label={server.path ? t("settings.code.found", { path: server.path }) : t("settings.code.notFound")}
            />
          </span>
          {crashed && <span className="settings-path">{t("settings.code.crashed")}</span>}
          {server.running > 0 && (
            <span className="settings-path" data-field="running">
              {t("settings.code.running", { count: server.running })}
            </span>
          )}
          {!server.path && (
            <small className="settings-hint" data-field="hint">
              {t("settings.code.installHint", { program: server.program })}
            </small>
          )}
        </div>
        <Switch
          checked={on}
          aria-label={t("settings.code.useServer", { language: languageLabel(language) })}
          disabled={busy || off}
          onChange={() => {
            if (!settings) return;
            const disabled = on ? [...settings.disabled, language] : settings.disabled.filter((l) => l !== language);
            void put({ ...settings, disabled });
          }}
        />
      </li>
    );
  }

  const idle = settings?.idleMinutes ?? 10;
  const idleChoices = IDLE_CHOICES.includes(idle) ? IDLE_CHOICES : [...IDLE_CHOICES, idle].sort((a, b) => a - b);

  return (
    <div className="settings-page code-intel">
      <header className="settings-head">
        <h3>{t("settings.code.title")}</h3>
        <p>{t("settings.code.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <ul className="settings-list">
        {settingShown(filter, "code.enabled") && (
          <li className="settings-item" data-setting-id="code.enabled">
            <div className="settings-item-text">
              <strong>{t("settings.code.enabled")}</strong>
            </div>
            <Switch
              checked={!off}
              aria-label={t("settings.code.enabled")}
              disabled={busy || !settings}
              onChange={() => settings && void put({ ...settings, enabled: !settings.enabled })}
            />
          </li>
        )}
      </ul>
      <SettingGroup ids={LANGUAGE_IDS} filter={filter}>
        <ul className="settings-list" data-section="servers" aria-disabled={off || undefined}>
          {LSP_LANGUAGES.map((l) => servers.find((s) => s.language === l)).map((s) => s && row(s))}
        </ul>
        <div className="settings-actions settings-actions-start">
          <Button variant="secondary" icon="refresh" disabled={busy} onClick={() => void lookAgain()}>
            {t("settings.code.lookAgain")}
          </Button>
        </div>
      </SettingGroup>
      <div className="ws-fields">
        <SettingRow id="code.idle" filter={filter}>
          <label className="ws-field">
            <span>{t("settings.code.idle")}</span>
            <Select
              value={String(idle)}
              disabled={busy || off}
              options={idleChoices.map((m) => ({ value: String(m), label: t("settings.code.idleMinutes", { count: m }) }))}
              onChange={(e) => settings && void put({ ...settings, idleMinutes: Number(e.target.value) })}
            />
          </label>
        </SettingRow>
        <SettingRow id="code.trusted" filter={filter}>
          <div className="code-intel-trusted">
            <Button variant="secondary" disabled={busy || !settings || settings.trusted.length === 0} onClick={() => void forget()}>
              {t("settings.code.forget")}
            </Button>
            <p className="settings-hint" role="status">
              {forgot !== null && t("settings.code.forgot", { count: forgot })}
            </p>
          </div>
        </SettingRow>
      </div>
    </div>
  );
}
