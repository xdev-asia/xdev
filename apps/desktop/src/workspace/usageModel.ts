import type { Accounts, Quota } from "@/api";
import type { useI18n } from "@/i18n";

type T = ReturnType<typeof useI18n>["t"];

export type UsageMode = "detailed" | "compact";
/** localStorage key of the popover mode. */
export const USAGE_MODE_KEY = "xdev.usage.mode";

export type UsageRow = {
  account: string;
  provider: string | null;
  state: Quota["state"];
  /** The login expired, was signed out, or never existed: the person has to sign in again. */
  signIn: boolean;
  /** `percent` is whole percent used (may pass 100), `resetsAt` is epoch milliseconds. */
  windows: { key: string; label: string; percent: number | null; resetsAt: number | null }[];
};

const SIGN_IN: ReadonlySet<string> = new Set(["expired", "logged_out", "no_credentials"]);

/** Label of a window key; an unknown key shows as itself. */
export function windowLabel(key: string, t: T): string {
  const label = t(`usage.popover.window.${key}`);
  return label.startsWith("usage.popover.window.") ? key : label;
}

/**
 * One row per account, in the order of `accounts`; quotas with no account follow in their own order.
 * Without `accounts` the quota order stands. `utilization` already is a percent.
 */
export function usageRows(quota: readonly Quota[], accounts: Accounts | null, t: T): UsageRow[] {
  const byName = new Map(quota.map((q) => [q.name, q]));
  const providers = new Map((accounts?.accounts ?? []).map((a) => [a.name, a.provider as string]));
  const order = [...(accounts?.accounts.map((a) => a.name) ?? []).filter((n) => byName.has(n)), ...quota.map((q) => q.name).filter((n) => !providers.has(n))];
  return order.map((name): UsageRow => {
    const q = byName.get(name)!;
    return {
      account: name,
      provider: providers.get(name) ?? null,
      state: q.state,
      signIn: q.reason !== null && SIGN_IN.has(q.reason),
      windows: q.windows.map((w) => {
        const at = w.resetsAt === null ? NaN : Date.parse(w.resetsAt);
        return {
          key: w.key,
          label: windowLabel(w.key, t),
          percent: w.utilization === null ? null : Math.round(w.utilization),
          resetsAt: Number.isNaN(at) ? null : at,
        };
      }),
    };
  });
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** When a window resets: relative under 24 h ("Resets in 2 h 10 min"), a date and time beyond. */
export function resetLabel(resetsAt: number | null, now: number, t: T): string {
  if (resetsAt === null) return t("usage.popover.reset.none");
  const left = resetsAt - now;
  if (left <= 0) return t("usage.popover.reset.now");
  if (left < DAY) {
    const minutes = Math.max(1, Math.ceil(left / MINUTE));
    return minutes < 60
      ? t("usage.popover.reset.minutes", { minutes })
      : t("usage.popover.reset.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  }
  const when = new Date(resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return t("usage.popover.reset.at", { when });
}
