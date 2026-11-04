import { Badge, Button, Card, StatusDot } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { SkillStatus } from "@/api";
import { useI18n } from "@/i18n";
import { coverageLine, skillState } from "./howTo";

/** The skill card: state badge, Install, Re-check, Copy install command, and per-agent coverage. */
export function SkillCard(props: {
  /** Null while the first read is under way. */
  status: SkillStatus | null;
  busy: boolean;
  copied: boolean;
  /** An error code to show inline, from the last install or re-check. */
  error?: string;
  onInstall(): void;
  /** Installs over an edited copy (the old one is backed up). */
  onReplace?(): void;
  onRecheck(): void;
  onCopyCommand(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { status } = props;
  const state = skillState(status);
  const line = coverageLine(status);
  const detected = status?.agents.filter((a) => a.detected) ?? [];
  return (
    <Card title={t("settings.orchestration.skill.title")} actions={<Badge status={state === "installed" ? "unchanged" : state === "edited" ? "changed" : "neutral"}>{t(`settings.orchestration.skill.state.${state}`)}</Badge>}>
      <p className="settings-path">{t("settings.orchestration.skill.text")}</p>
      <div className="settings-actions settings-actions-start">
        <Button type="button" data-act="install" disabled={props.busy} aria-busy={props.busy} onClick={props.onInstall}>
          {props.busy ? t("settings.orchestration.skill.installing") : t("settings.orchestration.skill.install")}
        </Button>
        {state === "edited" && props.onReplace && (
          <Button type="button" variant="secondary" data-act="replace" disabled={props.busy} onClick={props.onReplace}>
            {t("settings.orchestration.skill.replace")}
          </Button>
        )}
        <Button type="button" variant="secondary" data-act="recheck" disabled={props.busy} onClick={props.onRecheck}>
          {t("settings.orchestration.skill.recheck")}
        </Button>
        <Button type="button" variant="secondary" data-act="copy-command" disabled={status === null} onClick={props.onCopyCommand}>
          {props.copied ? t("settings.orchestration.skill.copied") : t("settings.orchestration.skill.copyCommand")}
        </Button>
      </div>
      {props.error && (
        <p className="error-text" role="alert" data-error="skill">
          {t(`error.${props.error}`)}
        </p>
      )}
      <h4 className="settings-group">{t("settings.orchestration.coverage.title")}</h4>
      {detected.length > 0 && (
        <ul className="orch-coverage" data-coverage="chips">
          {detected.map((a) => (
            <li key={a.id} className="orch-chip" data-agent={a.id} data-ready={a.ready}>
              <StatusDot state={a.ready ? "done" : "idle"} />
              <span>{a.name}</span>
              <span className="orch-chip-state">{t(a.ready ? "settings.orchestration.coverage.ready" : "settings.orchestration.coverage.missing")}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="settings-path" data-coverage="line">
        {line.hint ? `${t(line.key, line.vars)} ${t("settings.orchestration.coverage.hint")}` : t(line.key, line.vars)}
      </p>
    </Card>
  );
}
