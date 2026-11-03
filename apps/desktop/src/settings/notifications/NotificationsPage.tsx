import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type StatusSettings } from "@/api";
import { useI18n } from "@/i18n";
import type { SettingsSectionProps } from "@/settings/sections";
import { playStatusSound } from "@/status/sound";

// The channel switches, in the order the page lists them.
export const CHANNELS = ["os", "sound", "bell", "badge"] as const;
export type Channel = (typeof CHANNELS)[number];

export function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Settings → Notifications: one switch per status channel, and the sound's file and volume. */
export function NotificationsPage(props: SettingsSectionProps & { onSaved?(settings: StatusSettings): void }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [settings, setSettings] = useState<StatusSettings | null>(null);
  // The volume while the slider moves; saved when it is let go.
  const [volume, setVolume] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const [soundError, setSoundError] = useState<ApiError["code"]>();

  useEffect(() => {
    api.statusSettings().then(setSettings, (e) => setError(toApiError(e).code));
  }, [api]);

  const title = (
    <header className="settings-head">
      <h3>{t("settings.notifications.title")}</h3>
      <p>{t("settings.notifications.intro")}</p>
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
  const shownVolume = volume ?? current.volume;

  // Each write returns what was stored; the page shows that, not what it asked for.
  async function save(run: () => Promise<StatusSettings>, onError: (code: ApiError["code"]) => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setSoundError(undefined);
    try {
      const stored = await run();
      setSettings(stored);
      setVolume(null);
      props.onSaved?.(stored);
    } catch (e) {
      onError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  const put = (next: StatusSettings) => save(() => api.statusSettingsPut(next), setError);

  function commitVolume(): void {
    if (volume === null || volume === current.volume) return;
    void put({ ...current, volume: clampVolume(volume) });
  }

  async function pickSound(): Promise<void> {
    if (busy) return;
    const path = await api.pickSoundFile().catch(() => null);
    if (path === null) return;
    await save(() => api.statusSoundSet(path), setSoundError);
  }

  return (
    <div className="settings-page">
      {title}
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}

      <h4 className="settings-group">{t("settings.notifications.channels")}</h4>
      <ul className="settings-list">
        {CHANNELS.map((c) => (
          <li key={c} className="settings-item" data-channel={c}>
            <div className="settings-item-text">
              <strong>{t(`settings.notifications.${c}`)}</strong>
              <span className="settings-path">{t(`settings.notifications.${c}Hint`)}</span>
            </div>
            <button
              type="button"
              role="switch"
              className="agent-switch"
              aria-checked={current[c]}
              aria-label={t(`settings.notifications.${c}`)}
              disabled={busy}
              onClick={() => void put({ ...current, [c]: !current[c] })}
            />
          </li>
        ))}
      </ul>

      <h4 className="settings-group">{t("settings.notifications.soundGroup")}</h4>
      <div className="ws-fields">
        <label className="ws-field notif-volume">
          <span>{t("settings.notifications.volume", { value: shownVolume })}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={shownVolume}
            disabled={busy}
            data-field="volume"
            onChange={(e) => setVolume(clampVolume(Number(e.target.value)))}
            onPointerUp={commitVolume}
            onKeyUp={commitVolume}
            onBlur={commitVolume}
          />
        </label>
      </div>
      <p className="settings-empty" data-field="sound-file">
        {current.soundFile
          ? t("settings.notifications.soundOwn", { name: fileName(current.soundFile) })
          : t("settings.notifications.soundBeep")}
      </p>
      <div className="settings-actions settings-actions-start">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void pickSound()}>
          {t("settings.notifications.pickSound")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || current.soundFile === null}
          onClick={() => void save(() => api.statusSoundSet(null), setSoundError)}
        >
          {t("settings.notifications.useBeep")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void playStatusSound(api, { ...current, volume: shownVolume }, Date.now(), true)}
        >
          {t("settings.notifications.test")}
        </button>
      </div>
      {soundError ? (
        <p className="error-text" role="alert">
          {t(`error.${soundError}`)}
        </p>
      ) : (
        <p className="settings-empty">{t("settings.notifications.soundFileHint")}</p>
      )}
    </div>
  );
}
