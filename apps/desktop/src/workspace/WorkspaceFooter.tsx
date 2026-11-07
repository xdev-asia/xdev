import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode, Ref } from "react";
import type { Accounts, Api, Provider, Quota, StatusBarItems, UsageDisplay, UsageSettings } from "@/api";
import { useI18n } from "@/i18n";
import { StatusBar } from "@xdev-asia/ui";
import { LicenseStatus } from "@/components/StatusBar";
import { useLicense } from "@/license/useLicense";
import { setUsageSettings, useUsageSettings } from "@/settings/usageSettings";
import { ContextMenu } from "@/ui/ContextMenu";
import { ALL_ITEMS, useStatusBarItems } from "@/ui/statusBarItems";
import { useQuota } from "@/shell/useQuota";
import { UpdateCard } from "@/components/UpdateCard";
import { useUpdate, type Update } from "@/shell/useUpdate";
import { KeepAwakeItem } from "./KeepAwakeItem";
import { SshStatusItem } from "./SshStatusItem";
import { PeersStatusItem } from "@/peers/PeersStatusItem";
import { UsagePopover } from "./UsagePopover";
import { pushToast } from "./toastStore";
import { footerQuota, shownPercent } from "./usageModel";
import { hideUsageSegment, isMenuKey, loadEmptyCtaHidden, saveEmptyCtaHidden, segmentMenuItems, showEmptyCta, usageMenuItems } from "./usageMenu";

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

function MeterItem(props: { meter: Meter; display: UsageDisplay }): JSX.Element {
  const { t } = useI18n();
  const { label, percent, window } = props.meter;
  const known = percent !== null;
  // The number follows the display setting; the warning stays on the share used (80 %).
  const shown = known ? shownPercent(percent, props.display) : 0;
  const name = window ? t(`workspace.footer.window.${window}`) : "";
  // An unknown window key shows as itself.
  const windowName = name.startsWith("workspace.footer.window.") ? window : name;
  const title = known ? t("workspace.footer.meterTitle", { name: label, window: windowName, percent: shown, state: t(props.display === "remaining" ? "usage.stats.left" : "usage.stats.used") }) : t("workspace.footer.meterUnknown", { name: label });
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
          aria-valuenow={Math.min(100, shown)}
          aria-valuetext={`${shown}%`}
        >
          <span className="ws-meter-fill" style={{ width: `${Math.min(100, shown)}%` }} />
        </span>
      ) : null}
      <span className="ws-meter-pct">{known ? `${shown}%` : "–"}</span>
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
  /** Used (default) or Remaining: the number the meters show. */
  display?: UsageDisplay;
  version: string;
  update?: Update | null;
  onRestartUpdate?: () => void;
  /** Opens the token usage in the Agent kit; the link shows only when this is given. */
  onOpenUsage?: () => void;
  /** Makes the meters one button that toggles `usagePopover`; without it they are plain text. */
  onToggleUsage?: () => void;
  usageOpen?: boolean;
  usagePopover?: ReactNode;
  usageButtonRef?: Ref<HTMLButtonElement>;
  /** Right-click on the meters; `at` is where the menu opens. */
  onMetersMenu?: (at: { x: number; y: number }) => void;
  /** No account exists yet: shows a link to set up the meters in place of them. */
  emptyCta?: boolean;
  onSetupUsage?: () => void;
  /** Right-click on the set-up link. */
  onEmptyMenu?: (at: { x: number; y: number }) => void;
  /** The context menu, drawn after the popover. */
  menu?: ReactNode;
  /** Which of xDev's own items show (Settings > Appearance); all by default. The update notice and the meters are not items. */
  items?: StatusBarItems;
  /** The ports item (Ports in Settings → Appearance), shown before the keep-awake item. */
  ports?: ReactNode;
  /** The keep-awake item, shown before the version. */
  keepAwake?: ReactNode;
  /** The SSH connections segment; it renders nothing while no host is connected or connecting. */
  ssh?: ReactNode;
  /** The licence notice, for paying people; it renders nothing otherwise. */
  license?: ReactNode;
  /** The floating workspace item, after the agent counts. */
  floating?: ReactNode;
  /** The Computers segment (paired computers), after the SSH one. */
  peers?: ReactNode;
  hidden?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const items = props.items ?? ALL_ITEMS;
  const display = props.display ?? "used";
  const meters = (props.quota ?? []).map(meterOf);
  const onMetersContext = props.onMetersMenu
    ? (e: { preventDefault(): void; clientX: number; clientY: number }) => {
        e.preventDefault();
        props.onMetersMenu?.({ x: e.clientX, y: e.clientY });
      }
    : undefined;
  // Shift+F10 or the menu key opens the menu below the segment, where a pointer would be.
  const onMetersKey = props.onMetersMenu
    ? (e: { key: string; shiftKey: boolean; preventDefault(): void; currentTarget: { getBoundingClientRect(): { left: number; bottom: number } } }) => {
        if (!isMenuKey(e)) return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        props.onMetersMenu?.({ x: box.left, y: box.bottom });
      }
    : undefined;
  const onEmptyContext = props.onEmptyMenu
    ? (e: { preventDefault(): void; clientX: number; clientY: number }) => {
        e.preventDefault();
        props.onEmptyMenu?.({ x: e.clientX, y: e.clientY });
      }
    : undefined;
  const entries: (ReactNode | "spacer")[] = [
    items.branch && props.branch ? <span key="branch" className="ws-mono ws-footer-branch">{`⎇ ${props.branch}`}</span> : null,
    meters.length > 0 ? (
      props.onToggleUsage ? (
        <button
          key="meters"
          type="button"
          className="ws-meters ws-meters-btn"
          data-action="usage"
          ref={props.usageButtonRef}
          aria-label={t("usage.popover.open")}
          aria-haspopup="dialog"
          aria-expanded={props.usageOpen === true}
          onClick={props.onToggleUsage}
          onContextMenu={onMetersContext}
          onKeyDown={onMetersKey}
        >
          {meters.map((m) => (
            <MeterItem key={m.label} meter={m} display={display} />
          ))}
        </button>
      ) : (
        // One tab stop, so the footer is in the focus order and the meters are read out.
        <span key="meters" className="ws-meters" role="group" aria-label={t("workspace.footer.usage")} tabIndex={0} onContextMenu={onMetersContext} onKeyDown={onMetersKey}>
          {meters.map((m) => (
            <MeterItem key={m.label} meter={m} display={display} />
          ))}
        </span>
      )
    ) : null,
    meters.length === 0 && props.emptyCta ? (
      <button key="setup" type="button" className="ws-footer-link" data-action="usage-setup" title={t("usage.empty.hint")} onClick={props.onSetupUsage} onContextMenu={onEmptyContext}>
        {t("usage.empty.cta")}
      </button>
    ) : null,
    props.usageOpen ? props.usagePopover : null,
    props.menu,
    items.tokenUsage && props.onOpenUsage ? (
      <button key="tokens" type="button" className="ws-footer-link" data-action="token-usage" onClick={props.onOpenUsage}>
        {t("kit.usage.link")}
      </button>
    ) : null,
    "spacer",
    items.agents ? (
      <span key="running" className="ws-running">
        {props.running > 0 && <span className="ws-dot ws-pulse" data-dot="working" aria-hidden="true" />}
        {t("workspace.footer.running", { count: props.running })}
      </span>
    ) : null,
    items.agents ? (
      <span key="waiting" className="ws-waiting">
        {props.waiting > 0 && <span className="ws-dot" data-dot="needs-you" aria-hidden="true" />}
        {t("workspace.footer.waiting", { count: props.waiting })}
      </span>
    ) : null,
    props.floating,
    props.license,
    props.ssh,
    props.peers,
    items.ports ? props.ports : null,
    items.keepAwake ? props.keepAwake : null,
    items.version ? <span key="version" className="ws-mono">{`v${props.version}`}</span> : null,
    props.update ? <UpdateItem key="update" update={props.update} onRestart={props.onRestartUpdate} /> : null,
  ].filter((entry) => entry !== null && entry !== undefined && entry !== false);
  // The design system bar has no `hidden`; the wrapper carries it.
  return (
    <div className="ws-footer-host" hidden={props.hidden}>
      <StatusBar items={entries} />
    </div>
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
  /** Opens the Accounts app. */
  onManageAccounts?: () => void;
  /** Makes an account the active one of its provider; the "Use" action shows only when this is given. */
  onUseAccount?: (provider: Provider, name: string) => void;
  /** Opens Settings on the usage section; the menu row shows only when this is given. */
  onUsageSettings?: () => void;
  /** The ports item; shown when Settings → Appearance has it on. */
  ports?: ReactNode;
  /** Opens Settings on the SSH section; the SSH segment shows only when this is given. */
  onManageSsh?: () => void;
  /** Opens a terminal tab on an SSH host, by alias. */
  onOpenSshTerminal?: (alias: string) => void;
  /** Opens Settings on Account; the licence notice acts on it. */
  onOpenLicense?: () => void;
  /** The floating workspace item. */
  floating?: ReactNode;
  hidden?: boolean;
}): JSX.Element {
  const { api, hidden, onOpenLicense, onManageAccounts, onUseAccount, onUsageSettings, onManageSsh, onOpenSshTerminal, ...rest } = props;
  const { t } = useI18n();
  const { quota, loading, refresh } = useQuota(api, hidden === true);
  const update = useUpdate(api);
  const { notice, state: licenseState } = useLicense(api);
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; kind: "meters" | "empty" } | null>(null);
  const [ctaHidden, setCtaHidden] = useState(loadEmptyCtaHidden);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const usage = useUsageSettings();
  const items = useStatusBarItems();
  // The accounts give the order and the provider; they are read on mount, for the footer's provider
  // switches, again each time the popover opens, and when the `onAccountsChanged` listener fires.
  useEffect(() => {
    let stale = false;
    const read = () =>
      api.accounts().then(
        (found) => !stale && setAccounts(found),
        () => !stale && setAccounts(null),
      );
    void read();
    // A switch (here or in Accounts) moves the active mark while the popover stays open.
    const unlisten = api.onAccountsChanged(() => void read());
    return () => {
      stale = true;
      void unlisten.then((off) => off(), () => {});
    };
  }, [api, open]);
  // Closing hands the focus back to the meters button.
  useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // The footer going off screen closes the popover with it.
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  const close = () => setOpen(false);
  // Only when nothing is set up at all: not while loading, and not when the switches hide the meters.
  const emptyCta = showEmptyCta(quota, accounts, ctaHidden);
  const hideUsage = () => {
    setMenuAt(null);
    hideUsageSegment(usage, put, (undo) => pushToast({ text: t("usage.menu.hidden"), actions: [{ label: t("usage.menu.undo"), run: undo }] }));
  };
  const put = (next: UsageSettings, saved?: () => void) =>
    void api.usageSettingsPut(next).then(
      (stored) => {
        setUsageSettings(stored);
        saved?.();
      },
      () => pushToast({ text: t("usage.menu.failed") }),
    );
  const popover = (
    <UsagePopover
      quota={quota}
      accounts={accounts}
      loading={loading}
      display={usage.display}
      onRefresh={refresh}
      onOpenDetails={() => {
        close();
        rest.onOpenUsage?.();
      }}
      onManageAccounts={() => {
        close();
        onManageAccounts?.();
      }}
      onUse={onUseAccount}
      onClose={close}
    />
  );
  return (
    <>
      <UpdateCard update={update.state} onRestart={update.restart} />
      <WorkspaceFooter
      {...rest}
      license={<LicenseStatus notice={notice} state={licenseState} onOpen={onOpenLicense} />}
      hidden={hidden}
      items={items}
      quota={quota === null ? null : footerQuota(quota, accounts, usage.footer)}
      display={usage.display}
      update={update.state}
      onRestartUpdate={update.restart}
      onToggleUsage={() => setOpen((v) => !v)}
      usageOpen={open}
      usagePopover={popover}
      usageButtonRef={button}
      onMetersMenu={(at) => setMenuAt({ ...at, kind: "meters" })}
      emptyCta={emptyCta}
      onSetupUsage={onManageAccounts}
      onEmptyMenu={(at) => setMenuAt({ ...at, kind: "empty" })}
      menu={
        menuAt && (
          <ContextMenu
            at={menuAt}
            items={
              menuAt.kind === "empty"
                ? [{ id: "hide", labelKey: "usage.empty.hide", run: () => { saveEmptyCtaHidden(true); setCtaHidden(true); } }]
                : [
                    ...segmentMenuItems(
                      hideUsage,
                      onManageAccounts &&
                        (() => {
                          setMenuAt(null);
                          onManageAccounts();
                        }),
                    ),
                    { id: "sep-segment", labelKey: "", kind: "separator" as const },
                    ...usageMenuItems(
                      usage,
                      put,
                      onUsageSettings &&
                        (() => {
                          setMenuAt(null);
                          onUsageSettings();
                        }),
                    ),
                  ]
            }
            onClose={() => setMenuAt(null)}
          />
        )
      }
      ports={rest.ports}
      keepAwake={<KeepAwakeItem api={api} />}
      ssh={onManageSsh && <SshStatusItem api={api} onOpenTerminal={onOpenSshTerminal} onManage={onManageSsh} />}
      peers={<PeersStatusItem api={api} />}
      />
    </>
  );
}
