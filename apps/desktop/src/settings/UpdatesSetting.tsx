import { useEffect, useState } from "react";
import type { JSX, MouseEvent } from "react";
import { Button, Dialog, ListRow, Spinner, Tag } from "@xdev-asia/ui";
import { toApiError, type Api, type ApiError, type ReleaseBuild, type ReleaseList, type UpdateChannel, type UpdateDeferral } from "@/api";
import { useI18n } from "@/i18n";
import { phaseLine, useUpdateCheck, type CheckState } from "@/shell/useUpdateCheck";
import { SettingRow } from "./SettingRow";
import type { SettingsFilter } from "./sections";

export const UPDATE_CHANNELS: UpdateChannel[] = ["stable", "rc"];
/** The delays Rust accepts, in days; `UPDATE_DELAY_DAYS` there. */
export const UPDATE_DELAYS = [0, 1, 3, 7] as const;

/** The build picker: closed, or loading the list, or the list, or why it could not load. */
export type BuildsState = { kind: "closed" } | { kind: "loading" } | ReleaseList;

export type UpdatesViewProps = {
  version: string | null;
  state: CheckState;
  channel: UpdateChannel | null;
  delay: number | null;
  deferral: UpdateDeferral | null;
  builds: BuildsState;
  // The tag of a build whose install failed.
  buildFailed: string | null;
  // The older build waiting for the person to confirm the downgrade.
  confirm: ReleaseBuild | null;
  busy: boolean;
  filter?: SettingsFilter;
  // `rc` is true on a Shift-click: that check follows the release candidate feed.
  onCheck(rc: boolean): void;
  onRestart(): void;
  onChannel(next: UpdateChannel): void;
  onDelay(next: number): void;
  onBuilds(open: boolean): void;
  onPick(build: ReleaseBuild): void;
  onConfirm(): void;
  onCancelConfirm(): void;
  date(iso: string): string;
  t(key: string, vars?: Record<string, string | number>): string;
};

/** The Updates rows without any state of their own, so a test can draw each phase. */
export function UpdatesView(props: UpdatesViewProps): JSX.Element {
  const { state, filter, builds, t } = props;
  const line = phaseLine(state);
  const working = state.phase.kind === "checking" || state.phase.kind === "downloading";
  const ready = state.phase.kind === "ready";
  const notes = state.phase.kind === "ready" ? state.phase.notes : null;
  const deferral = state.phase.kind === "up-to-date" ? props.deferral : null;
  return (
    <>
      <SettingRow id="general.updates" filter={filter}>
        <div className="ws-fields">
          <div className="ws-field" data-field="updates">
            {props.version !== null && <span data-field="version">{t("settings.general.updates.version", { version: props.version })}</span>}
            <p className="settings-hint" role="status" data-field="update-status">
              {/* The status text names the work; the spinner is only the picture of it. */}
              {working && (
                <span aria-hidden="true">
                  <Spinner label={t(line.key, line.vars)} />
                </span>
              )}{" "}
              {t(line.key, line.vars)}
            </p>
            {deferral && (
              <p className="settings-hint" data-field="update-deferred">
                {t("settings.general.updates.deferred", { version: deferral.version, date: props.date(deferral.offerOn) })}
              </p>
            )}
            {state.phase.kind === "error" && state.phase.detail && (
              <small className="settings-hint" data-field="update-error-detail">
                {state.phase.detail}
              </small>
            )}
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
            {(props.delay ?? 0) > 0 && (
              <small className="settings-hint" data-field="update-delay-note">
                {t("settings.general.updates.checkDelayHint")}
              </small>
            )}
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
      <SettingRow id="general.updateDelay" filter={filter}>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("settings.general.updates.delay")}</span>
            <select
              value={props.delay ?? 0}
              disabled={props.busy || props.delay === null}
              data-field="update-delay"
              onChange={(e) => props.onDelay(Number(e.target.value))}
            >
              {UPDATE_DELAYS.map((d) => (
                <option key={d} value={d}>
                  {t(`settings.general.updates.delay.${d}`)}
                </option>
              ))}
            </select>
            <small className="settings-hint">{t("settings.general.updates.delayHint")}</small>
          </label>
        </div>
      </SettingRow>
      <SettingRow id="general.updateBuild" filter={filter}>
        <div className="ws-fields">
          <div className="ws-field" data-field="update-builds">
            <span>{t("settings.general.updates.build")}</span>
            <div className="settings-actions settings-actions-start">
              <button
                type="button"
                className="btn-secondary"
                data-act="builds-toggle"
                aria-expanded={builds.kind !== "closed"}
                onClick={() => props.onBuilds(builds.kind === "closed")}
              >
                {t(builds.kind === "closed" ? "settings.general.updates.build.choose" : "settings.general.updates.build.close")}
              </button>
            </div>
            {builds.kind === "loading" && (
              <p className="settings-hint" role="status" data-field="builds-loading">
                <span aria-hidden="true">
                  <Spinner label={t("settings.general.updates.build.loading")} />
                </span>{" "}
                {t("settings.general.updates.build.loading")}
              </p>
            )}
            {builds.kind === "error" && (
              <div role="alert" data-field="builds-error">
                <p className="settings-hint">{t(`settings.general.updates.build.error.${builds.reason === "rate-limit" ? "rateLimit" : builds.reason}`)}</p>
                <div className="settings-actions settings-actions-start">
                  <button type="button" className="btn-secondary" data-act="builds-retry" onClick={() => props.onBuilds(true)}>
                    {t("settings.general.updates.build.retry")}
                  </button>
                </div>
              </div>
            )}
            {builds.kind === "loaded" && builds.builds.length === 0 && <p className="settings-hint">{t("settings.general.updates.build.empty")}</p>}
            {builds.kind === "loaded" && builds.builds.length > 0 && (
              <ul aria-label={t("settings.general.updates.build.list")} data-field="builds-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {builds.builds.map((b) => (
                  <ListRow
                    key={b.tag}
                    as="li"
                    title={b.tag}
                    meta={b.publishedAt ? props.date(b.publishedAt) : t("settings.general.updates.build.dateUnknown")}
                    disabled={working || state.restart === "restarting"}
                    selected={props.buildFailed === b.tag}
                    trailing={
                      <>
                        {b.older && <Tag tone="warn">{t("settings.general.updates.build.older")}</Tag>}
                        {b.prerelease && <Tag>{t("settings.general.updates.build.prerelease")}</Tag>}
                      </>
                    }
                    onClick={() => props.onPick(b)}
                  />
                ))}
              </ul>
            )}
            {props.buildFailed !== null && (
              <small className="settings-hint" role="alert" data-field="build-install-error">
                {t("settings.general.updates.build.installFailed", { tag: props.buildFailed })}
              </small>
            )}
            <small className="settings-hint">{t("settings.general.updates.buildHint")}</small>
          </div>
        </div>
      </SettingRow>
      {props.confirm && (
        <Dialog
          modal
          alert
          title={t("settings.general.updates.build.confirmTitle", { tag: props.confirm.tag })}
          confirmLabel={t("settings.general.updates.build.confirm")}
          cancelLabel={t("settings.general.updates.build.cancel")}
          onConfirm={props.onConfirm}
          onCancel={props.onCancelConfirm}
        >
          {t("settings.general.updates.build.confirmBody")}
        </Dialog>
      )}
    </>
  );
}

type UpdatesApi = Pick<
  Api,
  "appVersion" | "shellSettings" | "shellSettingsPut" | "updateCheck" | "updatePhase" | "onUpdatePhase" | "shellQuit" | "updateDeferred" | "updateReleases" | "updateInstallTag"
>;

/** Settings → General → Updates: the version, a manual check, the restart, the channel, the delay and the build picker. */
export function UpdatesSetting(props: { api: UpdatesApi; filter?: SettingsFilter; onError(code: ApiError["code"]): void }): JSX.Element {
  const { api, filter, onError } = props;
  const { t, locale } = useI18n();
  const { state, check, restart } = useUpdateCheck(api);
  const [version, setVersion] = useState<string | null>(null);
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [deferral, setDeferral] = useState<UpdateDeferral | null>(null);
  const [builds, setBuilds] = useState<BuildsState>({ kind: "closed" });
  const [buildFailed, setBuildFailed] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ReleaseBuild | null>(null);
  const [busy, setBusy] = useState(false);
  const open = builds.kind !== "closed";

  useEffect(() => {
    api.appVersion().then(setVersion, () => {});
    api.shellSettings().then(
      (s) => {
        setChannel(s.updateChannel);
        setDelay(s.updateDelayDays);
      },
      (e) => onError(toApiError(e).code),
    );
  }, [api, onError]);

  // A check that ended holds back a release or not; ask Rust which.
  useEffect(() => {
    if (state.phase.kind !== "up-to-date") return;
    let stale = false;
    api.updateDeferred().then((d) => !stale && setDeferral(d), () => {});
    return () => {
      stale = true;
    };
  }, [api, state.phase]);

  async function load(): Promise<void> {
    setBuilds({ kind: "loading" });
    try {
      setBuilds(await api.updateReleases());
    } catch (e) {
      setBuilds({ kind: "error", reason: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  // The list follows the channel: release candidates only show on the release candidate channel.
  useEffect(() => {
    if (open && channel !== null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  async function put(patch: { updateChannel?: UpdateChannel; updateDelayDays?: number }): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      // Read again: the window settings may have changed since the page opened.
      const stored = await api.shellSettingsPut({ ...(await api.shellSettings()), ...patch });
      setChannel(stored.updateChannel);
      setDelay(stored.updateDelayDays);
    } catch (e) {
      onError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }
  // A Shift check makes Rust follow the release candidate feed from then on; the select shows it.
  const onCheck = (rc: boolean) => void check(rc).then(() => api.shellSettings().then((s) => setChannel(s.updateChannel), () => {}));

  async function install(build: ReleaseBuild): Promise<void> {
    setConfirm(null);
    setBuildFailed(null);
    try {
      const end = await api.updateInstallTag(build.tag);
      if (end.kind === "error") setBuildFailed(build.tag);
    } catch {
      setBuildFailed(build.tag);
    }
  }
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { dateStyle: "medium" });
  };

  return (
    <UpdatesView
      version={version}
      state={state}
      channel={channel}
      delay={delay}
      deferral={deferral}
      builds={builds}
      buildFailed={buildFailed}
      confirm={confirm}
      busy={busy}
      filter={filter}
      onCheck={onCheck}
      onRestart={restart}
      onChannel={(c) => void put({ updateChannel: c })}
      onDelay={(d) => void put({ updateDelayDays: d })}
      onBuilds={(next) => {
        setBuildFailed(null);
        if (next) void load();
        else setBuilds({ kind: "closed" });
      }}
      onPick={(b) => (b.older ? setConfirm(b) : void install(b))}
      onConfirm={() => confirm && void install(confirm)}
      onCancelConfirm={() => setConfirm(null)}
      date={date}
      t={t}
    />
  );
}
