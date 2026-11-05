import { Badge, Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type CliStatus, type SkillStatus } from "@/api";
import { useI18n } from "@/i18n";
import { SettingRow } from "../SettingRow";
import type { SettingsSectionProps } from "../sections";
import { SkillCard } from "../orchestration/SkillCard";

export type CliState = "checking" | "notInstalled" | "installed" | "stale" | "notOnPath";

/** What the status line says; a stale link comes first, then a folder that is not on PATH. */
export function cliState(s: CliStatus | null): CliState {
  if (s === null) return "checking";
  if (s.stale) return "stale";
  if (!s.installed) return "notInstalled";
  return s.onPath ? "installed" : "notOnPath";
}

const COPIED_MS = 2000;

/** Settings → Command line: the `xdev` command on PATH, and the agent skill that uses it. */
export function CliPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [skill, setSkill] = useState<SkillStatus | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillError, setSkillError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function refreshSkill(): Promise<void> {
    setSkillError(undefined);
    setSkill(null);
    try {
      setSkill(await api.orchestrationSkillStatus());
    } catch (e) {
      setSkillError(toApiError(e).code);
    }
  }

  useEffect(() => {
    api.cliStatus().then(setStatus, (e) => setError(toApiError(e).code));
    void refreshSkill();
    return () => clearTimeout(copyTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function installSkill(force: boolean): Promise<void> {
    setSkillBusy(true);
    setSkillError(undefined);
    try {
      setSkill(await (force ? api.orchestrationSkillInstall(true) : api.orchestrationSkillInstall()));
    } catch (e) {
      setSkillError(toApiError(e).code);
    } finally {
      setSkillBusy(false);
    }
  }

  async function run(action: () => Promise<CliStatus>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await action());
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  const state = cliState(status);
  const noBinary = status !== null && status.targetPath === null;
  const folder = status?.linkPath ? status.linkPath.replace(/[\\/][^\\/]*$/, "") : "";
  const badge = state === "installed" ? "unchanged" : state === "checking" ? "neutral" : "changed";
  const installing = state === "notInstalled";

  return (
    <div className="settings-page cli-page">
      <header className="settings-head">
        <h3>{t("settings.cli.title")}</h3>
        <p>{t("settings.cli.lead")}</p>
      </header>

      <SettingRow id="cli.status" filter={filter}>
        <div className="diagnostics-row">
          <div className="diagnostics-text">
            <strong>
              {t("settings.cli.command")} <Badge status={badge}>{t(`settings.cli.state.${state}`)}</Badge>
            </strong>
            {state === "stale" && <span data-cli="hint">{t("settings.cli.hint.stale")}</span>}
            {state === "notOnPath" && <span data-cli="hint">{t("settings.cli.hint.notOnPath", { folder })}</span>}
            {installing && !noBinary && <span data-cli="hint">{t("settings.cli.hint.notInstalled")}</span>}
            {noBinary && <span data-cli="hint">{t("settings.cli.hint.noBinary")}</span>}
            {status?.linkPath && <span className="settings-path">{status.linkPath}</span>}
            {error && (
              <span className="error-text" role="alert" data-error="cli">
                {t(`error.${error}`)}
              </span>
            )}
          </div>
          <div className="settings-actions settings-actions-start">
            {state === "stale" ? (
              <>
                <Button type="button" data-act="repair" disabled={busy || noBinary} onClick={() => void run(() => api.cliRepair())}>
                  {t("settings.cli.repair")}
                </Button>
                <Button type="button" variant="secondary" data-act="remove" disabled={busy} onClick={() => void run(() => api.cliRemove())}>
                  {t("settings.cli.remove")}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                data-act={installing ? "install" : "remove"}
                variant={installing ? undefined : "secondary"}
                disabled={busy || status === null || (installing && noBinary)}
                onClick={() => void run(() => (installing ? api.cliInstall() : api.cliRemove()))}
              >
                {t(installing ? "settings.cli.install" : "settings.cli.remove")}
              </Button>
            )}
            <Button type="button" variant="secondary" data-act="reveal" disabled={noBinary} onClick={() => void api.cliReveal().catch((e) => setError(toApiError(e).code))}>
              {t("settings.cli.reveal")}
            </Button>
          </div>
        </div>
      </SettingRow>

      <SettingRow id="cli.skill" filter={filter}>
        <SkillCard
          status={skill}
          busy={skillBusy}
          copied={copied}
          error={skillError}
          onInstall={() => void installSkill(false)}
          onReplace={() => void installSkill(true)}
          onRecheck={() => void refreshSkill()}
          onCopyCommand={() => {
            if (skill === null) return;
            void Promise.resolve(navigator.clipboard?.writeText(skill.installCommand)).catch(() => undefined);
            setCopied(true);
            clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
          }}
        />
      </SettingRow>
    </div>
  );
}
