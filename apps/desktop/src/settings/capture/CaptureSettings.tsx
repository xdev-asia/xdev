import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Banner, Button, FieldMessage, Kbd, Switch } from "@xdev-asia/ui";
import { toApiError, type ApiError, type CapturePermission, type CaptureSettings as Settings, type ShortcutStatus } from "@/api";
import { useI18n } from "@/i18n";
import { PLATFORM } from "@/platform";
import { copyText } from "@/ui/clipboard";
import { ShortcutRecorder } from "../shortcuts/ShortcutRecorder";
import { settingShown } from "../SettingRow";
import type { SettingsSectionProps } from "../sections";
import { acceleratorLabel, toAccelerator } from "./chord";

/** What a desktop shortcut runs where the app cannot hold a global one (Wayland). */
export const CAPTURE_COMMAND = "xdev capture";
const TAKEN_ID = "capture-shortcut-taken";

/** Settings → Screenshots: the global capture shortcut and whether pasted images open for annotation first. */
export function CaptureSettings(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [permission, setPermission] = useState<CapturePermission | null>(null);
  const [recording, setRecording] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    const fail = (e: unknown) => setError(toApiError(e).code);
    api.captureSettings().then(setSettings, fail);
    api.captureShortcutApply().then(setStatus, fail);
    api.capturePermission().then(setPermission, fail);
  }, [api]);

  // The write sets the shortcut again; the status says whether the chord was free.
  async function put(next: Settings): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setSettings(await api.captureSettingsPut(next));
      setStatus(await api.captureShortcutApply());
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  const stopRecording = useCallback(() => setRecording(false), []);
  const onChord = (chord: string) => {
    setRecording(false);
    if (settings) void put({ ...settings, shortcut: toAccelerator(chord, PLATFORM) });
  };
  const onClear = () => {
    setRecording(false);
    if (settings) void put({ ...settings, shortcut: "" });
  };

  const taken = status?.status === "taken";
  const shortcut = settings?.shortcut.trim() ?? "";

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.capture.title")}</h3>
        <p>{t("settings.capture.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      {permission === "denied" && (
        <Banner
          title={t("capture.perm.title")}
          action={
            <Button variant="secondary" onClick={() => void api.captureOpenPrivacy().catch((e) => setError(toApiError(e).code))}>
              {t("capture.perm.open")}
            </Button>
          }
        >
          {t("capture.perm.body")}
        </Banner>
      )}
      {status?.status === "unsupported" && (
        <Banner
          title={t("capture.wayland.title")}
          action={
            <Button variant="secondary" onClick={() => void copyText(CAPTURE_COMMAND).then(setCopied)}>
              {t("capture.wayland.copy")}
            </Button>
          }
        >
          {t("capture.wayland.body")} <code>{CAPTURE_COMMAND}</code>
          <span role="status" className="settings-hint">
            {copied !== null && t(copied ? "capture.wayland.copied" : "capture.wayland.copyFailed")}
          </span>
        </Banner>
      )}
      <ul className="settings-list">
        {settingShown(filter, "capture.enabled") && (
          <li className="settings-item" data-setting-id="capture.enabled">
            <div className="settings-item-text">
              <strong>{t("settings.capture.enabled")}</strong>
              <span className="settings-path">{t("settings.capture.enabledHint")}</span>
            </div>
            <Switch
              checked={!!settings?.enabled}
              aria-label={t("settings.capture.enabled")}
              disabled={busy || !settings}
              onChange={() => settings && void put({ ...settings, enabled: !settings.enabled })}
            />
          </li>
        )}
        {settingShown(filter, "capture.shortcut") && (
          <li className="settings-item" data-setting-id="capture.shortcut">
            <div className="settings-item-text">
              <strong>{t("settings.capture.shortcut")}</strong>
              <span className="settings-path" data-field="chord">
                {shortcut ? <Kbd>{acceleratorLabel(shortcut, PLATFORM)}</Kbd> : t("settings.capture.none")}
              </span>
              {taken && (
                <FieldMessage id={TAKEN_ID}>{t("capture.err.shortcutTaken")}</FieldMessage>
              )}
              {recording && (
                <ShortcutRecorder clash={null} onChord={onChord} onClear={onClear} onReplace={stopRecording} onCancel={stopRecording} />
              )}
            </div>
            <Button
              variant="secondary"
              disabled={busy || !settings || !settings.enabled || recording}
              aria-describedby={taken ? TAKEN_ID : undefined}
              onClick={() => setRecording(true)}
            >
              {t("settings.capture.change")}
            </Button>
          </li>
        )}
        {settingShown(filter, "capture.annotatePaste") && (
          <li className="settings-item" data-setting-id="capture.annotatePaste">
            <div className="settings-item-text">
              <strong>{t("settings.capture.annotatePaste")}</strong>
              <span className="settings-path">{t("settings.capture.annotatePasteHint")}</span>
            </div>
            <Switch
              checked={!!settings?.annotatePaste}
              aria-label={t("settings.capture.annotatePaste")}
              disabled={busy || !settings}
              onChange={() => settings && void put({ ...settings, annotatePaste: !settings.annotatePaste })}
            />
          </li>
        )}
      </ul>
    </div>
  );
}
