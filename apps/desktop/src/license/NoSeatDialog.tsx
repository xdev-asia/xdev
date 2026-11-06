import { Button, Dialog } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { DeviceRow } from "@xdev/bindings";
import { toApiError, type Api, type ApiError } from "@/api";
import { useI18n } from "@/i18n";

export type NoSeatApi = Pick<Api, "licenseDevices" | "licenseDeactivate" | "licenseActivate">;

export interface NoSeatDialogProps {
  api: NoSeatApi;
  /** Closed by the button, Esc, or after the license moved here. */
  onClose(): void;
}

/** The devices that hold a Pro seat. */
export function seatHolders(rows: DeviceRow[]): DeviceRow[] {
  return rows.filter((d) => d.proGrant !== null && d.revokedAt === null);
}

/** Every Pro seat is taken: lists who holds one and moves it to this device. */
export function NoSeatDialog({ api, onClose }: NoSeatDialogProps): JSX.Element {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError["code"]>();

  useEffect(() => {
    let live = true;
    void api.licenseDevices().then(
      (r) => live && setRows(seatHolders(r)),
      (e: unknown) => {
        if (!live) return;
        setRows([]);
        setError(toApiError(e).code);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  function move(id: string): void {
    setBusy(id);
    setError(undefined);
    api
      .licenseDeactivate(id)
      .then(() => api.licenseActivate())
      .then(onClose, (e: unknown) => {
        setBusy(null);
        setError(toApiError(e).code);
      });
  }

  return (
    <Dialog title={t("license.noSeat.title")} modal confirmLabel={t("license.noSeat.close")} cancelLabel={null} onConfirm={onClose} onCancel={onClose} body="plain">
      <p>{t("license.noSeat.body")}</p>
      {error && (
        <p className="settings-hint" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <ul className="settings-list">
        {(rows ?? []).map((d) => (
          <li key={d.id} className="settings-item">
            <div className="settings-item-text">
              <strong>{d.name}</strong>
              <span className="settings-hint">
                {d.platform}
                {d.lastSeenAt !== null &&
                  ` · ${t("license.devices.lastSeen", { date: new Date(d.lastSeenAt * 1000).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) })}`}
              </span>
            </div>
            <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => move(d.id)} aria-label={t("license.noSeat.moveFrom", { name: d.name })}>
              {t("license.noSeat.move")}
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
