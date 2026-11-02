import type { JSX } from "react";
import type { Quota } from "../api";
import { useI18n } from "../i18n";
import type { AppId } from "../shell/apps";

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

function AccountItem(props: { quota: Quota[]; onOpen(app: AppId): void }): JSX.Element {
  const { t } = useI18n();
  const best = roomiest(props.quota);
  const fiveHour = best?.windows.find((w) => w.key === "five_hour")?.utilization ?? null;
  const text =
    best === null
      ? t("status.noRoom")
      : fiveHour === null
        ? t("status.accountNoWindow", { name: best.name })
        : t("status.account", { name: best.name, percent: Math.round(fiveHour) });
  return (
    <button type="button" className="statusbar-end" onClick={() => props.onOpen("accounts")}>
      {text}
    </button>
  );
}

export function StatusBar(props: {
  vaultName: string;
  docCount: number;
  staleCount: number;
  /** `null` when the folder is not tracked by git; `undefined` while that is not known yet. */
  changeCount: number | null | undefined;
  quota: Quota[] | null;
  onOpen(app: AppId): void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <footer className="statusbar" aria-label={t("status.label")}>
      <span>{props.vaultName}</span>
      <span>{t("sidebar.count", { count: props.docCount })}</span>
      {props.staleCount > 0 && (
        <button type="button" onClick={() => props.onOpen("docs")}>
          {t("status.stale", { count: props.staleCount })}
        </button>
      )}
      {props.changeCount === null ? (
        <span>{t("status.untracked")}</span>
      ) : props.changeCount === undefined ? null : (
        <button type="button" onClick={() => props.onOpen("changes")}>
          {t("status.changes", { count: props.changeCount })}
        </button>
      )}
      {props.quota !== null && props.quota.length > 0 && <AccountItem quota={props.quota} onOpen={props.onOpen} />}
    </footer>
  );
}
