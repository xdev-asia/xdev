import { Badge, Button, Dialog, Segmented, Select } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type MicDevice, type MicPermission, type SpeechMode, type SpeechSettings } from "@/api";
import { useI18n } from "@/i18n";
import { settingShown } from "../SettingRow";
import type { SettingsSectionProps } from "../sections";
import { OpenAiKeyDialog } from "./OpenAiKeyDialog";

/** The transcription models the backend accepts; the first is its default. */
export const SPEECH_MODELS = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"] as const;
/** Languages offered besides "Detect automatically"; ISO-639-1. */
export const SPEECH_LANGUAGES = ["en", "vi", "ja", "ko", "zh", "fr", "de", "es"] as const;

type Dialogs = "key" | "disconnect" | null;

function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Settings → Voice: how the dictation key records, the microphone, the language and model, and the OpenAI key. */
export function VoicePage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [permission, setPermission] = useState<MicPermission | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    const fail = (e: unknown) => setError(toApiError(e).code);
    api.speechSettingsGet().then(setSettings, fail);
    api.speechDevices().then(setDevices, fail);
    api.speechPermission().then(setPermission, fail);
    api.aiKeys().then((rows) => setConnected(rows.some((r) => r.provider === "openai" && r.saved)), fail);
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
  const put = (next: Partial<SpeechSettings>) =>
    settings && void run(async () => setSettings(await api.speechSettingsPut({ ...settings, ...next })));

  const device = settings?.device ?? "";
  const micOptions = [{ value: "", label: t("settings.voice.micDefault") }, ...devices.map((d) => ({ value: d.name, label: d.name }))];
  if (device && !devices.some((d) => d.name === device)) micOptions.push({ value: device, label: device });
  const language = settings?.language ?? "";
  const languages: string[] = [...SPEECH_LANGUAGES];
  if (language && !languages.includes(language)) languages.push(language);
  const languageOptions = [{ value: "", label: t("settings.voice.languageAuto") }, ...languages.map((c) => ({ value: c, label: languageName(c, locale) }))];
  const model = settings?.model ?? SPEECH_MODELS[0];
  const models: string[] = [...SPEECH_MODELS];
  if (!models.includes(model)) models.push(model);

  const showPermission = permission !== null && permission !== "notNeeded";
  const permLabel = permission === "granted" ? "settings.voice.permGranted" : permission === "denied" ? "settings.voice.permDenied" : "settings.voice.permUnknown";

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.voice.title")}</h3>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`, { detail: "" })}
        </p>
      )}
      <ul className="settings-list">
        {settingShown(filter, "voice.mode") && (
          <li className="settings-item" data-setting-id="voice.mode">
            <div className="settings-item-text">
              <strong>{t("settings.voice.mode")}</strong>
            </div>
            <Segmented
              label={t("settings.voice.mode")}
              value={settings?.mode ?? "toggle"}
              disabled={busy || !settings}
              options={[
                { value: "toggle", label: t("settings.voice.toggle") },
                { value: "hold", label: t("settings.voice.hold") },
              ]}
              onChange={(v) => put({ mode: v as SpeechMode })}
            />
          </li>
        )}
        {settingShown(filter, "voice.mic") && (
          <li className="settings-item" data-setting-id="voice.mic">
            <div className="settings-item-text">
              <strong>{t("settings.voice.mic")}</strong>
            </div>
            <Select
              aria-label={t("settings.voice.mic")}
              data-field="mic"
              value={device}
              disabled={busy || !settings}
              options={micOptions}
              onChange={(e) => put({ device: e.target.value || null })}
            />
          </li>
        )}
        {settingShown(filter, "voice.language") && (
          <li className="settings-item" data-setting-id="voice.language">
            <div className="settings-item-text">
              <strong>{t("settings.voice.language")}</strong>
            </div>
            <Select
              aria-label={t("settings.voice.language")}
              data-field="language"
              value={language}
              disabled={busy || !settings}
              options={languageOptions}
              onChange={(e) => put({ language: e.target.value || null })}
            />
          </li>
        )}
        {settingShown(filter, "voice.model") && (
          <li className="settings-item" data-setting-id="voice.model">
            <div className="settings-item-text">
              <strong>{t("settings.voice.model")}</strong>
            </div>
            <Select
              aria-label={t("settings.voice.model")}
              data-field="model"
              value={model}
              disabled={busy || !settings}
              options={models.map((m) => ({ value: m, label: m }))}
              onChange={(e) => put({ model: e.target.value })}
            />
          </li>
        )}
        {showPermission && settingShown(filter, "voice.permission") && (
          <li className="settings-item" data-setting-id="voice.permission">
            <div className="settings-item-text">
              <strong>{t("settings.voice.permission")}</strong>
              <Badge status={permission === "granted" ? "new" : "neutral"} tone={permission === "denied" ? "danger" : undefined}>
                {t(permLabel)}
              </Badge>
            </div>
            {permission === "notDetermined" && (
              <Button variant="secondary" data-act="allow" disabled={busy} onClick={() => void run(async () => setPermission(await api.speechPermissionRequest()))}>
                {t("settings.voice.allow")}
              </Button>
            )}
            {permission === "denied" && (
              <Button variant="secondary" data-act="privacy" onClick={() => void run(() => api.speechOpenPrivacy())}>
                {t("settings.voice.openPrivacy")}
              </Button>
            )}
          </li>
        )}
        {settingShown(filter, "voice.key") && (
          <li className="settings-item" data-setting-id="voice.key">
            <div className="settings-item-text">
              <strong>{t("settings.voice.key")}</strong>
              <span className="settings-path">{t("settings.voice.keyHint")}</span>
              {connected !== null && (
                <Badge status={connected ? "new" : "neutral"}>{t(connected ? "settings.voice.connected" : "settings.voice.notConnected")}</Badge>
              )}
            </div>
            <div className="settings-actions">
              <Button variant="secondary" data-act="key" disabled={busy || connected === null} onClick={() => setDialog("key")}>
                {t(connected ? "settings.voice.replace" : "settings.voice.connect")}
              </Button>
              {connected && (
                <Button variant="secondary" data-act="disconnect" disabled={busy} onClick={() => setDialog("disconnect")}>
                  {t("settings.voice.disconnect")}
                </Button>
              )}
            </div>
          </li>
        )}
      </ul>
      {dialog === "key" && (
        <OpenAiKeyDialog
          api={api}
          onCancel={() => setDialog(null)}
          onSaved={() => {
            setConnected(true);
            setDialog(null);
          }}
        />
      )}
      {dialog === "disconnect" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("settings.voice.disconnectTitle")}
          confirmLabel={t("settings.voice.disconnect")}
          labels={{ cancel: t("dialog.cancel") }}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void run(async () => {
              await api.aiKeyRemove("openai");
              setConnected(false);
              setDialog(null);
            })
          }
        >
          {t("settings.voice.disconnectBody")}
        </Dialog>
      )}
    </div>
  );
}
