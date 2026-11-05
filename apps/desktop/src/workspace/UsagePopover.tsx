import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Button, EmptyState } from "@xdev-asia/ui";
import type { Accounts, Provider, Quota, UsageDisplay } from "@/api";
import { useI18n } from "@/i18n";
import { resetLabel, shownPercent, USAGE_MODE_KEY, usageRows, type UsageMode, type UsageRow } from "./usageModel";

/** The saved mode; Detailed when nothing is saved or storage cannot be read. */
export function loadUsageMode(): UsageMode {
  try {
    return localStorage.getItem(USAGE_MODE_KEY) === "compact" ? "compact" : "detailed";
  } catch {
    return "detailed";
  }
}

function saveUsageMode(mode: UsageMode): void {
  try {
    localStorage.setItem(USAGE_MODE_KEY, mode);
  } catch {
    // The choice just won't survive a restart.
  }
}

/** The window that runs out first: the highest percent; ties keep the first. */
function busiest(row: UsageRow): UsageRow["windows"][number] | null {
  let best: UsageRow["windows"][number] | null = null;
  for (const w of row.windows) if (w.percent !== null && (best === null || w.percent > (best.percent ?? -1))) best = w;
  return best;
}

/** `percent` is the number to show (used or left); the caller has already applied the display. */
function Bar(props: { state: UsageRow["state"]; percent: number; label: string }): JSX.Element {
  const shown = Math.min(100, Math.max(0, props.percent));
  return (
    <span className="ws-usage-bar" data-state={props.state} role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-valuetext={`${props.percent}%`}>
      <span className="ws-usage-fill" style={{ width: `${shown}%` }} />
    </span>
  );
}

export interface UsagePopoverViewProps {
  rows: UsageRow[] | null;
  mode: UsageMode;
  /** Used (default) or Remaining. */
  display?: UsageDisplay;
  loading: boolean;
  now: number;
  readAt: number | null;
  onMode(mode: UsageMode): void;
  onRefresh(): void;
  onOpenDetails(): void;
  onManageAccounts(): void;
  /** Makes `account` the active one of `provider`; without it the rows have no "Use" action. */
  onUse?(provider: Provider, account: string): void;
  onClose(): void;
}

/** The markup of the popover; `UsagePopover` adds the state around it. */
export function UsagePopoverView(props: UsagePopoverViewProps): JSX.Element {
  const { t } = useI18n();
  const { rows, mode } = props;
  const display = props.display ?? "used";
  const word = t(display === "remaining" ? "usage.stats.left" : "usage.stats.used");
  const pct = (used: number) => shownPercent(used, display);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), []);

  function key(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <>
      <div className="ws-menu-backdrop" data-action="usage-backdrop" onClick={props.onClose} />
      <div className="ws-usage-pop" ref={root} role="dialog" aria-label={t("usage.popover.title")} tabIndex={-1} onKeyDown={key}>
        <div className="ws-usage-head">
          <span className="ws-usage-title">{t("usage.popover.title")}</span>
          {props.readAt !== null && (
            <span className="ws-usage-asof">{t("usage.popover.asOf", { time: new Date(props.readAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) })}</span>
          )}
          <span className="ws-footer-spacer" />
          <button type="button" className="ws-usage-btn" data-action="usage-refresh" aria-busy={props.loading} disabled={props.loading} onClick={props.onRefresh}>
            {props.loading && <span className="ws-usage-spinner" role="status" aria-label={t("usage.popover.loading")} />}
            {t("usage.popover.refresh")}
          </button>
          <span className="ws-usage-modes" role="group" aria-label={t("usage.popover.mode")}>
            {(["detailed", "compact"] as const).map((m) => (
              <button key={m} type="button" className="ws-usage-btn" data-action={`usage-mode-${m}`} aria-pressed={mode === m} onClick={() => props.onMode(m)}>
                {t(`usage.popover.mode.${m}`)}
              </button>
            ))}
          </span>
        </div>
        {rows === null ? (
          <p className="ws-usage-empty" role="status">{t(props.loading ? "usage.popover.loading" : "usage.popover.unreadable")}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("usage.popover.empty")}
            hint={t("usage.popover.emptyHint")}
            actions={<Button type="button" data-action="usage-connect" onClick={props.onManageAccounts}>{t("usage.popover.connect")}</Button>}
          />
        ) : (
          <div className="ws-usage-list">
            {rows.map((row) => {
              const top = busiest(row);
              return (
                <div key={row.account} className="ws-usage-account" data-state={row.state}>
                  <div className="ws-usage-line">
                    <span className="ws-usage-name">{row.account}</span>
                    {row.provider && <span className="ws-usage-provider">{row.provider}</span>}
                    {row.active && <span className="ws-usage-active" data-action="usage-active">{t("accounts.switch.active")}</span>}
                    {!row.active && !row.signIn && row.provider && props.onUse && (
                      <button type="button" className="ws-usage-btn ws-usage-use" data-action="usage-use" aria-label={t("accounts.switch.useAria", { name: row.account })} onClick={() => props.onUse?.(row.provider as Provider, row.account)}>
                        {t("usage.popover.use")}
                      </button>
                    )}
                    {mode === "compact" && top ? (
                      <>
                        <Bar state={row.state} percent={pct(top.percent ?? 0)} label={`${row.account}: ${top.label} (${word})`} />
                        <span className="ws-usage-pct" title={word}>{`${pct(top.percent ?? 0)}%`}</span>
                        <span className="ws-usage-window">{top.label}</span>
                      </>
                    ) : (
                      <span className="ws-usage-state">{t(`usage.popover.state.${row.state}`)}</span>
                    )}
                  </div>
                  {mode === "detailed" &&
                    row.windows.map((w) => (
                      <div key={w.key} className="ws-usage-window-row">
                        <span className="ws-usage-window">{w.label}</span>
                        {w.percent !== null ? <Bar state={row.state} percent={pct(w.percent)} label={`${row.account}: ${w.label} (${word})`} /> : null}
                        <span className="ws-usage-pct" title={word}>{w.percent === null ? "–" : `${pct(w.percent)}%`}</span>
                        <span className="ws-usage-reset">{resetLabel(w.resetsAt, props.now, t)}</span>
                      </div>
                    ))}
                  {row.signIn && (
                    <button type="button" className="ws-usage-signin" data-action="sign-in" onClick={props.onManageAccounts}>
                      {t("usage.popover.signIn", { name: row.account })}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="ws-usage-foot">
          <button type="button" className="ws-usage-btn" data-action="usage-details" onClick={props.onOpenDetails}>
            {t("usage.popover.details")}
          </button>
          <button type="button" className="ws-usage-btn" data-action="usage-manage" onClick={props.onManageAccounts}>
            {t("usage.popover.manage")}
          </button>
        </div>
      </div>
    </>
  );
}

/** The usage popover over the footer: every account with its limit windows, and links to the details and the accounts. */
export function UsagePopover(props: {
  quota: Quota[] | null;
  accounts: Accounts | null;
  display?: UsageDisplay;
  loading: boolean;
  onRefresh(): void;
  onOpenDetails(): void;
  onManageAccounts(): void;
  onUse?(provider: Provider, account: string): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<UsageMode>(loadUsageMode);
  const [readAt, setReadAt] = useState<number | null>(() => (props.quota ? Date.now() : null));
  const { quota } = props;
  useEffect(() => {
    if (quota) setReadAt(Date.now());
  }, [quota]);
  const rows = quota === null ? null : usageRows(quota, props.accounts, t);
  return (
    <UsagePopoverView
      rows={rows}
      mode={mode}
      display={props.display}
      loading={props.loading}
      now={Date.now()}
      readAt={readAt}
      onMode={(m) => {
        setMode(m);
        saveUsageMode(m);
      }}
      onRefresh={props.onRefresh}
      onOpenDetails={props.onOpenDetails}
      onManageAccounts={props.onManageAccounts}
      onUse={props.onUse}
      onClose={props.onClose}
    />
  );
}
