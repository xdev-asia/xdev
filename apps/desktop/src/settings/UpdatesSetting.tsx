import { useEffect, useState } from "react";
import type { JSX, MouseEvent } from "react";
import { Button, Spinner } from "@xdev-asia/ui";
import { toApiError, type Api, type ApiError, type UpdateChannel } from "@/api";
import { useI18n } from "@/i18n";
import { phaseLine, useUpdateCheck, type CheckState } from "@/shell/useUpdateCheck";
import { SettingRow } from "./SettingRow";
import type { SettingsFilter } from "./sections";

export const UPDATE_CHANNELS: UpdateChannel[] = ["stable", "rc"];

export type UpdatesViewProps = {
  version: string | null;
  state: CheckState;
  channel: UpdateChannel | null;
  busy: boolean;
  filter?: SettingsFilter;
  // `rc` is true on a Shift-click: that check follows the release candidate feed.
  onCheck(rc: boolean): void;
  onRestart(): void;
  onChannel(next: UpdateChannel): void;
  t(key: string, vars?: Record<string, string | number>): string;
};

/** The Updates rows without any state of their own, so a test can draw each phase. */
export function UpdatesView(props: UpdatesViewProps): JSX.Element {
  const { state, filter, t } = props;
  const line = phaseLine(state);
  const working = state.phase.kind === "checking" || state.phase.kind === "downloading";
  const ready = state.phase.kind === "ready";
  const notes = state.phase.kind === "ready" ? state.phase.notes : null;
  return (
    <>
      <SettingRow id="general.updates" filter={filter}>
        <div className="ws-fields">
          <div className="ws-field" data-field="updates">
            {props.version !== null && <span data-field="version">{t("settings.general.updates.version", { version: props.version })}</span>}
            <p className="settings-hint" role="status" data-field="update-status">
              {working && <Spinner label={t(line.key, line.vars)} />} {t(line.key, line.vars)}
            </p>
            {notes && (
              <details data-field="update-notes">
                <summary>{t("settings.general.updates.notes")}</summary>
                <p className="settings-hint">{notes}</p>
              </details>
            )}
            <div className="settings-actions settings-actions-start">
              <button
                type="button"
                className="btn-secondary"
                data-act="update-check"
                disabled={working || state.restart === "restarting"}
                onClick={(e: MouseEvent) => props.onCheck(e.shiftKey)}
              >
                {t("settings.general.updates.check")}
              </button>
              {ready && (
                <Button type="button" data-act="update-restart" disabled={state.restart === "restarting"} onClick={props.onRestart}>
                  {t("settings.general.updates.restart")}
                </Button>
              )}
            </div>
            <small className="settings-hint">{t("settings.general.updates.checkHint")}</small>
          </div>
        </div>
      </SettingRow>
      <SettingRow id="general.updateChannel" filter={filter}>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("settings.general.updates.channel")}</span>
            <select
              value={props.channel ?? "stable"}
              disabled={props.busy || props.channel === null}
              data-field="update-channel"
              onChange={(e) => props.onChannel(e.target.value as UpdateChannel)}
            >
              {UPDATE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`settings.general.updates.channel.${c}`)}
                </option>
              ))}
            </select>
            <small className="settings-hint">{t("settings.general.updates.channelHint")}</small>
          </label>
        </div>
      </SettingRow>
    </>
  );
}

type UpdatesApi = Pick<Api, "appVersion" | "shellSettings" | "shellSettingsPut" | "updateCheck" | "updatePhase" | "onUpdatePhase" | "shellQuit">;

/** Settings → General → Updates: the version, a manual check, the restart and the release channel. */
export function UpdatesSetting(props: { api: UpdatesApi; filter?: SettingsFilter; onError(code: ApiError["code"]): void }): JSX.Element {
  const { api, filter, onError } = props;
  const { t } = useI18n();
  const { state, check, restart } = useUpdateCheck(api);
  const [version, setVersion] = useState<string | null>(null);
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.appVersion().then(setVersion, () => {});
    api.shellSettings().then((s) => setChannel(s.updateChannel), (e) => onError(toApiError(e).code));
  }, [api, onError]);

  async function pick(next: UpdateChannel): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      // Read again: the window settings may have changed since the page opened.
      const stored = await api.shellSettingsPut({ ...(await api.shellSettings()), updateChannel: next });
      setChannel(stored.updateChannel);
    } catch (e) {
      onError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  // A Shift check makes Rust follow the release candidate feed from then on; the select shows it.
  const onCheck = (rc: boolean) => void check(rc).then(() => api.shellSettings().then((s) => setChannel(s.updateChannel), () => {}));

  return <UpdatesView version={version} state={state} channel={channel} busy={busy} filter={filter} onCheck={onCheck} onRestart={restart} onChannel={(c) => void pick(c)} t={t} />;
}
