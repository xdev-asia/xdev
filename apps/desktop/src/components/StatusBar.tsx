import type { JSX } from "react";
import type { Quota } from "../api";
import { useI18n } from "../i18n";
import type { AppId } from "../shell/apps";
import type { Update } from "../shell/useUpdate";

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

export type VaultStatus = {
  name: string;
  docCount: number;
  staleCount: number;
  /** `null` when the folder is not tracked by git; `undefined` while that is not known yet. */
  changeCount: number | null | undefined;
};

function VaultItems(props: { vault: VaultStatus; onOpen(app: AppId): void }): JSX.Element {
  const { t } = useI18n();
  const { vault } = props;
  return (
    <>
      {vault.staleCount > 0 && (
        <button type="button" className="statusbar-warn" onClick={() => props.onOpen("docs")}>
          {t("status.stale", { count: vault.staleCount })}
        </button>
      )}
      <span className="statusbar-vault">{vault.name}</span>
      <span>{t("sidebar.count", { count: vault.docCount })}</span>
      {vault.changeCount === null ? (
        <span>{t("status.untracked")}</span>
      ) : vault.changeCount === undefined ? null : (
        <button type="button" onClick={() => props.onOpen("changes")}>
          {t("status.changes", { count: vault.changeCount })}
        </button>
      )}
    </>
  );
}

function UpdateItem(props: { update: Update; onRestart(): void }): JSX.Element {
  const { t } = useI18n();
  const { update } = props;
  if (update.status === "restarting") return <span className="statusbar-end">{t("status.updating")}</span>;
  return (
    <button type="button" className="statusbar-end" title={update.notes ?? undefined} onClick={props.onRestart}>
      {update.status === "failed" ? t("status.updateFailed") : t("status.update", { version: update.version })}
    </button>
  );
}

export function StatusBar(props: {
  vault: VaultStatus | null;
  quota: Quota[] | null;
  update?: Update | null;
  onRestartUpdate?(): void;
  onOpen(app: AppId): void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <footer className="statusbar" aria-label={t("status.label")}>
      {props.vault ? <VaultItems vault={props.vault} onOpen={props.onOpen} /> : <span>{t("status.noVault")}</span>}
      {props.update && <UpdateItem update={props.update} onRestart={() => props.onRestartUpdate?.()} />}
      {props.quota !== null && props.quota.length > 0 && <AccountItem quota={props.quota} onOpen={props.onOpen} />}
    </footer>
  );
}
