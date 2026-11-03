import type { JSX } from "react";
import type { Api, Quota } from "@/api";
import { useI18n } from "@/i18n";
import { useQuota } from "@/shell/useQuota";
import { useUpdate, type Update } from "@/shell/useUpdate";

/** A meter above this share of its window shows in the warn colour. */
export const WARN_PERCENT = 80;

export interface Meter {
  label: string;
  /** Whole percent of the busiest window, or `null` when nothing is known. */
  percent: number | null;
  /** Key of the busiest window; empty when there is none. */
  window: string;
}

/** One meter for an account: the window with the highest use, since that one runs out first. */
export function meterOf(q: Quota): Meter {
  let window = "";
  let best: number | null = null;
  // Strict `>` so ties keep the first window listed.
  for (const w of q.windows) {
    if (w.utilization !== null && (best === null || w.utilization > best)) {
      best = w.utilization;
      window = w.key;
    }
  }
  if (q.state === "unknown" || best === null) return { label: q.name, percent: null, window: "" };
  return { label: q.name, percent: Math.round(best), window };
}

function MeterItem(props: { meter: Meter }): JSX.Element {
  const { t } = useI18n();
  const { label, percent, window } = props.meter;
  const known = percent !== null;
  const name = window ? t(`workspace.footer.window.${window}`) : "";
  // An unknown window key shows as itself.
  const windowName = name.startsWith("workspace.footer.window.") ? window : name;
  const title = known ? t("workspace.footer.meterTitle", { name: label, window: windowName, percent }) : t("workspace.footer.meterUnknown", { name: label });
  return (
    <span className={`ws-meter${known && percent >= WARN_PERCENT ? " ws-meter-warn" : ""}`} title={title}>
      <span className="ws-meter-name">{label}</span>
      {known ? (
        <span
          className="ws-meter-bar"
          role="meter"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent)}
          aria-valuetext={`${percent}%`}
        >
          <span className="ws-meter-fill" style={{ width: `${Math.min(100, percent)}%` }} />
        </span>
      ) : null}
      <span className="ws-meter-pct">{known ? `${percent}%` : "–"}</span>
    </span>
  );
}

/** A downloaded update: restart to apply it, progress while restarting, a retry after a failure. */
function UpdateItem(props: { update: Update; onRestart?: () => void }): JSX.Element {
  const { t } = useI18n();
  const { update } = props;
  if (update.status === "restarting") return <span className="ws-update-busy">{t("status.updating")}</span>;
  return (
    <button type="button" className="ws-update" title={update.notes ?? t("status.update", { version: update.version })} onClick={props.onRestart}>
      {update.status === "failed" ? t("status.updateFailed") : t("workspace.footer.update", { version: update.version })}
    </button>
  );
}

/** The bar under the workspace: branch, usage per account, agent counts, the build version and a ready update. */
export function WorkspaceFooter(props: {
  branch: string | null;
  running: number;
  waiting: number;
  quota: Quota[] | null;
  version: string;
  update?: Update | null;
  onRestartUpdate?: () => void;
  /** Opens the token usage in the Agent kit; the link shows only when this is given. */
  onOpenUsage?: () => void;
  hidden?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const meters = (props.quota ?? []).map(meterOf);
  return (
    <footer className="ws-footer" hidden={props.hidden}>
      {props.branch && <span className="ws-mono ws-footer-branch">{`⎇ ${props.branch}`}</span>}
      {meters.length > 0 && (
        // One tab stop, so the footer is in the focus order and the meters are read out.
        <span className="ws-meters" role="group" aria-label={t("workspace.footer.usage")} tabIndex={0}>
          {meters.map((m) => (
            <MeterItem key={m.label} meter={m} />
          ))}
        </span>
      )}
      {props.onOpenUsage && (
        <button type="button" className="ws-footer-link" data-action="token-usage" onClick={props.onOpenUsage}>
          {t("kit.usage.link")}
        </button>
      )}
      <span className="ws-footer-spacer" />
      <span className="ws-running">
        {props.running > 0 && <span className="ws-dot ws-pulse" data-dot="working" aria-hidden="true" />}
        {t("workspace.footer.running", { count: props.running })}
      </span>
      <span className="ws-waiting">
        {props.waiting > 0 && <span className="ws-dot" data-dot="needs-you" aria-hidden="true" />}
        {t("workspace.footer.waiting", { count: props.waiting })}
      </span>
      <span className="ws-mono">{`v${props.version}`}</span>
      {props.update && <UpdateItem update={props.update} onRestart={props.onRestartUpdate} />}
    </footer>
  );
}

/** The footer fed by the live quota and update state; quota reading pauses while the footer is not on screen. */
export function LiveWorkspaceFooter(props: {
  api: Api;
  branch: string | null;
  running: number;
  waiting: number;
  version: string;
  onOpenUsage?: () => void;
  hidden?: boolean;
}): JSX.Element {
  const { api, hidden, ...rest } = props;
  const quota = useQuota(api, hidden === true);
  const update = useUpdate(api);
  return <WorkspaceFooter {...rest} hidden={hidden} quota={quota} update={update.state} onRestartUpdate={update.restart} />;
}
