import type { JSX } from "react";
import type { LicenseState } from "@xdev/bindings";
import type { Quota } from "@/api";
import { useI18n } from "@/i18n";

function highestUse(account: Quota): number {
  return Math.max(0, ...account.windows.flatMap((w) => (w.utilization === null ? [] : [w.utilization])));
}

export function roomiest(quota: Quota[]): Quota | null {
  let best: Quota | null = null;
  for (const account of quota) {
    if (account.state !== "ok") continue;
    // Strict `<` so ties keep list order.
    if (best === null || highestUse(account) < highestUse(best)) best = account;
  }
  return best;
}

/** The notices a paying person should see in the status bar; a free person with none sees nothing. */
export const STATUS_NOTICES = ["clock", "revoked", "expired"] as const;
export type StatusNotice = (typeof STATUS_NOTICES)[number];

export function statusNoticeOf(notice: string | null): StatusNotice | null {
  return STATUS_NOTICES.find((n) => n === notice) ?? null;
}

/** Whether a subscription (sync or team) is on this device; a one-time Pro licence is not one. */
export function hasSubscription(state: LicenseState | null): boolean {
  if (state?.state !== "active") return false;
  return state.team !== null || state.syncUntil !== null || state.plan.some((p) => p === "sync" || p === "team");
}

/** The notice to show: `expired` only matters to someone whose subscription ran out, not to one-time Pro. */
export function statusNoticeFor(notice: string | null, state: LicenseState | null): StatusNotice | null {
  const n = statusNoticeOf(notice);
  return n === "expired" && !hasSubscription(state) ? null : n;
}

/** One compact licence notice: a status dot, a tint, and a click that opens Settings → Account. */
export function LicenseStatus(props: {
  notice: string | null;
  /** The licence state; `expired` shows only while a subscription is on it. */
  state?: LicenseState | null;
  onOpen?: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const notice = props.state === undefined ? statusNoticeOf(props.notice) : statusNoticeFor(props.notice, props.state);
  if (!notice) return null;
  return (
    <span role="status" className="ws-license" data-notice={notice}>
      <button type="button" className="ws-license-btn" data-action="license-status" onClick={props.onOpen}>
        <span className="ws-dot" data-tone={notice === "expired" ? "danger" : "warn"} aria-hidden="true" />
        {t(`license.notice.${notice}.title`)}
      </button>
    </span>
  );
}
