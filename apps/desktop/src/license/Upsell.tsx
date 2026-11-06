import { Button, Dialog } from "@xdev-asia/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { toApiError, type Api } from "@/api";
import { useI18n } from "@/i18n";
import { LicenseUpsellContext } from "./ProGate";

/** Where "Learn more" goes. */
export const PRICING_URL = "https://xdev.asia/pricing";

export type UpsellApi = Pick<Api, "licenseBuy" | "licenseBuyCancel" | "openUrl">;

/** The name shown for a feature id, such as `pro.early`. Unknown ids show as a plain "xDev Pro" feature. */
export function featureLabelKey(feature: string): string {
  return `pro.feature.${feature.replace(/^pro\./, "")}`;
}

export interface UpsellProps {
  api: UpsellApi;
  /** The Pro feature id the person tried to use. */
  feature: string;
  /** Closed by the button, Esc, or once the purchase reached this device. */
  onClose(): void;
}

/** What xDev Pro is, shown when a free device reaches for a Pro feature. One primary button: Get xDev Pro. */
export function Upsell({ api, feature, onClose }: UpsellProps): JSX.Element {
  const { t } = useI18n();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  function buy(): void {
    setWaiting(true);
    setError(undefined);
    api.licenseBuy("pro").then(
      () => {
        if (live.current) onClose();
      },
      (e: unknown) => {
        if (!live.current) return;
        setWaiting(false);
        const code = toApiError(e).code;
        if (code !== "cancelled") setError(code);
      },
    );
  }

  function close(): void {
    if (waiting) void api.licenseBuyCancel().catch(() => undefined);
    onClose();
  }

  return (
    <Dialog
      title={t("pro.upsell.title", { feature: t(featureLabelKey(feature)) })}
      modal
      body="plain"
      confirmLabel={t("license.getPro")}
      confirmDisabled={waiting}
      cancelLabel={t("pro.upsell.close")}
      onConfirm={buy}
      onCancel={close}
    >
      <p>{t("pro.upsell.body")}</p>
      <p>
        <Button type="button" variant="secondary" onClick={() => void api.openUrl(PRICING_URL).catch(() => undefined)}>
          {t("pro.upsell.learn")}
        </Button>
      </p>
      {waiting && (
        <p className="settings-hint" role="status">
          {t("license.checkout.waiting")}
        </p>
      )}
      {error && (
        <p className="settings-hint" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
    </Dialog>
  );
}

/** Provides `LicenseUpsellContext` to everything below it and shows the upsell it asks for. Mount once. */
export function UpsellHost({ api, children }: { api: UpsellApi; children: ReactNode }): JSX.Element {
  const [feature, setFeature] = useState<string | null>(null);
  const open = useCallback((f: string) => setFeature(f), []);
  return (
    <LicenseUpsellContext.Provider value={open}>
      {children}
      {feature !== null && <Upsell api={api} feature={feature} onClose={() => setFeature(null)} />}
    </LicenseUpsellContext.Provider>
  );
}
