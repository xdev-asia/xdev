import { Badge, Banner, Button, Card, Checkbox, Field, Segmented } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ConnectKind, type TaskSource, type TrackerPulls, type TrackersView } from "@/api";
import { useI18n } from "@/i18n";
import type { SettingsSectionProps } from "./sections";
import "@/styles/trackers.css";

type Mode = "cloud" | "server";
type Drafts = { token: string; site: string; email: string; base: string };
type Errors = Partial<Record<"token" | "site" | "email" | "base", string>>;

const EMPTY: Drafts = { token: "", site: "", email: "", base: "" };

/** Settings → Integrations → Task trackers: what feeds the Tasks list besides GitHub issues. */
export function TrackersPage({ api }: SettingsSectionProps): JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<TrackersView | null>(null);
  const [mode, setMode] = useState<Mode>("cloud");
  const [drafts, setDrafts] = useState<Drafts>(EMPTY);
  const [errors, setErrors] = useState<Record<"linear" | "jira", Errors>>({ linear: {}, jira: {} });
  const [busy, setBusy] = useState(false);
  const [keychain, setKeychain] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .trackersStatus()
      .then((v) => {
        if (!live) return;
        setView(v);
        if (v.jira.mode === "server") setMode("server");
      })
      .catch((e) => {
        if (live && toApiError(e).code === "secret_store") setKeychain(true);
      });
    return () => {
      live = false;
    };
  }, [api]);

  function draft(key: keyof Drafts, value: string): void {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  async function run(tracker: "linear" | "jira", work: () => Promise<TrackersView>, field: keyof Errors): Promise<void> {
    setBusy(true);
    setErrors((prev) => ({ ...prev, [tracker]: {} }));
    try {
      setView(await work());
      setKeychain(false);
      // Never keep a token once it is sent.
      setDrafts((prev) => ({ ...prev, token: "" }));
    } catch (e) {
      const code = toApiError(e).code;
      if (code === "secret_store") {
        setKeychain(true);
      } else {
        const emailMissing = tracker === "jira" && mode === "cloud" && drafts.email.trim() === "";
        const where: keyof Errors = code === "tracker_bad_url" ? (mode === "cloud" ? "site" : "base") : code === "empty_key" && emailMissing ? "email" : field;
        setErrors((prev) => ({ ...prev, [tracker]: { [where]: t(`error.${code}`) } }));
      }
    } finally {
      setBusy(false);
    }
  }

  const connectLinear = (): Promise<void> =>
    run("linear", () => api.trackerConnect({ kind: "linear", url: "", email: "", token: drafts.token.trim() }), "token");

  const connectJira = (): Promise<void> => {
    const kind: ConnectKind = mode === "cloud" ? "jiraCloud" : "jiraServer";
    return run(
      "jira",
      () =>
        api.trackerConnect({
          kind,
          url: (mode === "cloud" ? drafts.site : drafts.base).trim(),
          email: mode === "cloud" ? drafts.email.trim() : "",
          token: drafts.token.trim(),
        }),
      "token",
    );
  };

  const disconnect = (tracker: "linear" | "jira"): Promise<void> => run(tracker, () => api.trackerDisconnect(tracker), "token");

  function pullsOf(source: TaskSource): TrackerPulls | null {
    if (!view) return null;
    return source === "github" ? view.github : view[source].pulls;
  }

  function checklist(source: TaskSource): JSX.Element | null {
    const pulls = pullsOf(source);
    if (!pulls) return null;
    const keys: (keyof TrackerPulls)[] = source === "github" ? ["assigned", "created"] : ["assigned", "created", "done"];
    const onlyOne = pulls.assigned !== pulls.created;
    return (
      <fieldset className="trk-pulls" data-pulls={source}>
        <legend>{t("settings.trackers.pulls")}</legend>
        {keys.map((key) => (
          <Checkbox
            key={key}
            label={t(`settings.trackers.pulls.${key}`)}
            checked={pulls[key]}
            disabled={busy || (onlyOne && pulls[key] && (key === "assigned" || key === "created"))}
            onChange={(e) =>
              void (async () => {
                setBusy(true);
                try {
                  setView(await api.trackerPullsSet(source, { ...pulls, [key]: e.target.checked }));
                } catch (err) {
                  if (toApiError(err).code === "secret_store") setKeychain(true);
                } finally {
                  setBusy(false);
                }
              })()
            }
          />
        ))}
      </fieldset>
    );
  }

  const status = (on: boolean): JSX.Element => (
    <Badge status={on ? "new" : "neutral"}>{t(on ? "settings.trackers.connected" : "settings.trackers.notConnected")}</Badge>
  );

  const linear = view?.linear;
  const jira = view?.jira;

  return (
    <div className="trk-page">
      <p className="settings-hint">{t("settings.trackers.readOnly")}</p>
      {keychain && <Banner title={t("error.secret_store")} />}

      <Card title="GitHub">
        <p className="settings-hint">{t("settings.trackers.github.hint")}</p>
        {checklist("github")}
      </Card>

      <Card title="Linear" actions={status(linear?.connected ?? false)}>
        {linear?.connected ? (
          <>
            <p className="settings-hint" role="status">
              {t("settings.trackers.connectedAs", { name: linear.account ?? "" })}
            </p>
            {checklist("linear")}
            <div className="settings-actions settings-actions-start">
              <Button type="button" variant="secondary" data-act="disconnect-linear" disabled={busy} onClick={() => void disconnect("linear")}>
                {t("settings.trackers.disconnect")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-hint">{t("settings.trackers.linear.hint")}</p>
            <Field
              label={t("settings.trackers.linear.key")}
              type="password"
              data-field="linear-token"
              value={drafts.token}
              error={errors.linear.token}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => draft("token", e.target.value)}
            />
            <div className="settings-actions settings-actions-start">
              <Button type="button" variant="secondary" data-act="connect-linear" disabled={busy || drafts.token.trim() === ""} onClick={() => void connectLinear()}>
                {t("settings.trackers.connect")}
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card title="Jira" actions={status(jira?.connected ?? false)}>
        {jira?.connected ? (
          <>
            <p className="settings-hint" role="status">
              {t("settings.trackers.connectedAs", { name: jira.account ?? "" })}
            </p>
            {checklist("jira")}
            <div className="settings-actions settings-actions-start">
              <Button type="button" variant="secondary" data-act="disconnect-jira" disabled={busy} onClick={() => void disconnect("jira")}>
                {t("settings.trackers.disconnect")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Segmented
              label="Jira"
              value={mode}
              disabled={busy}
              options={[
                { value: "cloud", label: t("settings.trackers.jira.cloud") },
                { value: "server", label: t("settings.trackers.jira.server") },
              ]}
              onChange={(next) => {
                setMode(next as Mode);
                setErrors((prev) => ({ ...prev, jira: {} }));
              }}
            />
            <div className="trk-jira-fields">
              {mode === "cloud" ? (
                <>
                  <Field label={t("settings.trackers.jira.site")} data-field="jira-site" value={drafts.site} placeholder={t("settings.trackers.jira.siteHint")} error={errors.jira.site} autoComplete="off" spellCheck={false} onChange={(e) => draft("site", e.target.value)} />
                  <Field label={t("settings.trackers.jira.email")} type="email" data-field="jira-email" value={drafts.email} error={errors.jira.email} autoComplete="off" spellCheck={false} onChange={(e) => draft("email", e.target.value)} />
                  <Field label={t("settings.trackers.jira.token")} type="password" data-field="jira-token" value={drafts.token} error={errors.jira.token} autoComplete="off" spellCheck={false} onChange={(e) => draft("token", e.target.value)} />
                </>
              ) : (
                <>
                  <Field label={t("settings.trackers.jira.base")} data-field="jira-base" value={drafts.base} error={errors.jira.base} autoComplete="off" spellCheck={false} onChange={(e) => draft("base", e.target.value)} />
                  <Field label={t("settings.trackers.jira.pat")} type="password" data-field="jira-token" value={drafts.token} error={errors.jira.token} autoComplete="off" spellCheck={false} onChange={(e) => draft("token", e.target.value)} />
                </>
              )}
            </div>
            <div className="settings-actions settings-actions-start">
              <Button
                type="button"
                variant="secondary"
                data-act="connect-jira"
                disabled={busy || drafts.token.trim() === "" || (mode === "cloud" ? drafts.site.trim() === "" : drafts.base.trim() === "")}
                onClick={() => void connectJira()}
              >
                {t("settings.trackers.connect")}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
