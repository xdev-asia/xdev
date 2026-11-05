import type { Api, QuotaAlert } from "@/api";
import { toApiError } from "@/api";
import type { ToastInput } from "./toastStore";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** One toast per account, window and threshold: a repeat of the same alert replaces it. */
export const alertToastId = (alert: QuotaAlert): string => `quota-alert:${alert.provider}:${alert.account}:${alert.window}:${alert.threshold}`;

/**
 * Shows each quota alert the app raises as a toast that stays until closed, with one action:
 * start new tabs of that provider on another account. Running tabs keep theirs. Returns the stop.
 */
export function watchQuotaAlerts(deps: { api: Pick<Api, "onQuotaAlert" | "accountUseNext">; t: Translate; toast(input: ToastInput): string }): () => void {
  const { api, t, toast } = deps;
  let stopped = false;
  let unlisten: (() => void) | null = null;

  function show(alert: QuotaAlert): void {
    const id = alertToastId(alert);
    const window = t(`accounts.window.${alert.window}`);
    toast({
      id,
      ttlMs: 0,
      text: t("accounts.alert.text", { name: alert.account, used: Math.round(alert.utilization), window }),
      actions: [{ label: t("accounts.alert.useNext"), run: () => void useNext(alert) }],
    });
  }

  async function useNext(alert: QuotaAlert): Promise<void> {
    try {
      const next = await api.accountUseNext(alert.provider, alert.account);
      toast({ id: alertToastId(alert), text: next === null ? t("accounts.alert.noOther", { name: alert.account }) : t("accounts.alert.switched", { name: next }) });
    } catch (e) {
      toast({ id: alertToastId(alert), text: t("accounts.switch.failed", { code: toApiError(e).code }) });
    }
  }

  void api
    .onQuotaAlert((alert) => {
      if (!stopped) show(alert);
    })
    .then((off) => {
      if (stopped) off();
      else unlisten = off;
    })
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten?.();
  };
}
