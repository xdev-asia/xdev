import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, PtydStatus } from "@/api";
import { useI18n } from "@/i18n";

/** Where terminals run, kept current by `ptyd://status`; null until the first answer. */
export function usePtydStatus(api: Pick<Api, "ptydStatus" | "onPtydStatus">): [PtydStatus | null, (s: PtydStatus) => void] {
  const [status, setStatus] = useState<PtydStatus | null>(null);
  useEffect(() => {
    let live = true;
    api.ptydStatus().then((s) => live && setStatus(s), () => {});
    const off = api.onPtydStatus((s) => live && setStatus(s));
    return () => {
      live = false;
      void off.then((stop) => stop());
    };
  }, [api]);
  return [status, setStatus];
}

/**
 * Above the terminals while the service could not start or answer: they run in the app and end
 * with it. Retry starts the service again; terminals already open stay where they are.
 */
export function PtydBanner(props: { api: Api }): JSX.Element | null {
  const { api } = props;
  const { t } = useI18n();
  const [status, setStatus] = usePtydStatus(api);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (status?.state !== "fallback") return null;

  async function retry(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      await api.ptydRestart();
      setStatus(await api.ptydStatus());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="banner banner-warn ws-tabs-banner" role="status" data-ptyd="fallback">
      <div className="banner-text">
        <strong>{t("ptyd.fallback")}</strong>
        {failed && <span>{t("ptyd.retryFailed")}</span>}
      </div>
      <div className="banner-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void retry()}>
          {t("ptyd.retry")}
        </button>
      </div>
    </div>
  );
}
