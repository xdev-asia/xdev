import { Banner, Button, Dialog, Spinner } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { DeviceRow } from "@xdev/bindings";
import { toApiError, type Api, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import { NoSeatDialog, seatHolders } from "@/license/NoSeatDialog";
import { useLicense, type LicenseApi } from "@/license/useLicense";
import { SettingRow } from "../SettingRow";
import type { SettingsFilter } from "../sections";

export type LicensePanelApi = LicenseApi & Pick<Api, "licenseDevices" | "licenseActivate" | "licenseDeactivate" | "licenseBuy" | "licenseBuyCancel">;

type Props = {
  api: LicensePanelApi;
  filter?: SettingsFilter;
  /** Signed out of xDev ID: the plan is checked against an account, so the person is asked to sign in. */
  signedIn: boolean;
  /** The clock, for "updates until" against "updates ended". */
  now?: number;
};

/** Settings → Account → License: the plan, its seats and devices, and the one way to get or refresh Pro. */
export function LicensePanel({ api, filter, signedIn, now = Date.now() }: Props): JSX.Element {
  const { t, locale } = useI18n();
  const license = useLicense(api);
  const { state, notice } = license;
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<ApiError["code"]>();
  const [buying, setBuying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [noSeat, setNoSeat] = useState(false);
  const [removing, setRemoving] = useState<DeviceRow | null>(null);

  const loadDevices = (): void => {
    api.licenseDevices().then(setDevices, () => undefined);
  };
  // The device list follows the license: a seat that moved, or a purchase that arrived.
  useEffect(() => {
    if (state) loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, api]);
  // A purchase that reached this device ends the wait.
  const pro = state?.state === "active";
  useEffect(() => {
    if (pro) setBuying(false);
  }, [pro]);

  if (!state) return <></>;

  const date = (seconds: number): string => new Date(seconds * 1000).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  function buy(): void {
    setError(undefined);
    setBuying(true);
    api.licenseBuy("pro").then(
      () => setBuying(false),
      (e: unknown) => {
        setBuying(false);
        const code = toApiError(e).code;
        if (code !== "cancelled") setError(code);
      },
    );
  }

  function stopWaiting(): void {
    void api.licenseBuyCancel().catch(() => undefined);
  }

  function refresh(): void {
    setError(undefined);
    setRefreshing(true);
    void license.refresh().finally(() => setRefreshing(false));
  }

  function activate(): void {
    setError(undefined);
    api.licenseActivate().then(
      () => undefined,
      (e: unknown) => {
        const code = toApiError(e).code;
        if (code === "license_no_seat") setNoSeat(true);
        else setError(code);
      },
    );
  }

  function deactivate(row: DeviceRow): void {
    setRemoving(null);
    setError(undefined);
    api.licenseDeactivate(row.id).then(
      () => loadDevices(),
      (e: unknown) => setError(toApiError(e).code),
    );
  }

  const active = state.state === "active" ? state : null;
  const updates = active?.pro?.updatesUntil != null ? active.pro.updatesUntil : null;
  const heldHere = (d: DeviceRow): boolean => active !== null && d.fingerprint === active.device.fingerprint;
  const holders = seatHolders(devices);

  return (
    <SettingRow id="account.license" filter={filter}>
      <div className="settings-card" data-setting="license" data-plan={active ? "pro" : "free"}>
        <div className="settings-item-text">
          <strong>{t("license.title")}</strong>
          <span>{active ? t("license.plan.pro") : t("license.plan.free")}</span>
        </div>
        <span className="settings-hint">{t("license.about")}</span>
        {updates !== null && (
          <span className="settings-hint">{now / 1000 <= updates ? t("license.updatesUntil", { date: date(updates) }) : t("license.updatesEnded", { date: date(updates) })}</span>
        )}
        {active && <span className="settings-hint">{t("license.devices", { used: active.device.active, seats: active.device.max })}</span>}
        {!signedIn && <span className="settings-hint">{t("license.signIn")}</span>}
        {notice && (
          <Banner title={t(`license.notice.${notice}.title`, { days: active?.freshness.kind === "grace" ? active.freshness.daysOffline : 0 })}>
            {t(`license.notice.${notice}.body`)}
          </Banner>
        )}
        {error && <Banner title={t(`error.${error}`)} />}
        {buying && (
          <div className="settings-item-text">
            <Spinner label={t("license.checkout.waiting")} />
            <span>{t("license.checkout.waiting")}</span>
            <Button type="button" variant="secondary" onClick={stopWaiting}>
              {t("license.checkout.stop")}
            </Button>
          </div>
        )}
        <div className="settings-actions">
          {active ? (
            <Button type="button" disabled={refreshing} onClick={refresh}>
              {t("license.refresh")}
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" onClick={activate}>
                {t("license.activate")}
              </Button>
              <Button type="button" variant={signedIn ? undefined : "secondary"} disabled={buying} onClick={buy}>
                {t("license.getPro")}
              </Button>
            </>
          )}
        </div>
        {holders.length > 0 && (
          <>
            <h4 className="settings-subgroup">{t("license.devices.title")}</h4>
            <ul className="settings-list">
              {holders.map((d) => (
                <li key={d.id} className="settings-item">
                  <div className="settings-item-text">
                    <strong>{d.name}</strong>
                    <span className="settings-hint">
                      {d.platform}
                      {d.lastSeenAt !== null && ` · ${t("license.devices.lastSeen", { date: date(d.lastSeenAt) })}`}
                      {heldHere(d) ? ` · ${t("license.devices.thisOne")}` : ""}
                    </span>
                  </div>
                  <Button type="button" variant="secondary" onClick={() => setRemoving(d)} aria-label={t("license.deactivate.named", { name: d.name })}>
                    {t("license.deactivate")}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {removing && (
        <Dialog
          modal
          alert
          title={t("license.deactivate.confirm.title", { name: removing.name })}
          confirmLabel={t("license.deactivate.confirm.yes")}
          cancelLabel={t("license.deactivate.confirm.no")}
          onConfirm={() => deactivate(removing)}
          onCancel={() => setRemoving(null)}
        >
          {t("license.deactivate.confirm.body", { name: removing.name })}
        </Dialog>
      )}
      {noSeat && <NoSeatDialog api={api} onClose={() => setNoSeat(false)} />}
    </SettingRow>
  );
}
