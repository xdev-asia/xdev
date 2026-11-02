import { Button } from "@xdev/ui";
import { useState } from "react";
import type { JSX } from "react";
import { api, type ApiError } from "../api";
import { useI18n } from "../i18n";
import type { AppId } from "../shell/apps";
import { useQuota } from "../shell/useQuota";
import { AccountsView } from "./AccountsView";
import { ActivityBar } from "./ActivityBar";
import { LanguageSwitch } from "./LanguageSwitch";
import { StatusBar } from "./StatusBar";

export type VaultFailure = { path: string; code: ApiError["code"] };

export function VaultEmpty(props: { failure?: VaultFailure; busy: boolean; onCreate(): void; onOpen(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="vault-empty">
      <h1 className="vault-empty-title">{t("vault.empty.title")}</h1>
      {props.failure ? (
        <p className="error-text" role="alert">
          {t("vault.empty.failed", { path: props.failure.path })} {t(`error.${props.failure.code}`)}
        </p>
      ) : (
        <p className="vault-empty-hint">{t("vault.empty.hint")}</p>
      )}
      <div className="vault-empty-actions">
        <Button type="button" disabled={props.busy} onClick={props.onCreate}>
          {t("vault.create")}
        </Button>
        <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onOpen}>
          {props.busy ? t("vault.opening") : t("vault.open")}
        </button>
      </div>
    </div>
  );
}

/** The workbench before any folder is open: Accounts works, the folder apps explain how to get one. */
export function NoVaultView(props: { failure?: VaultFailure; busy: boolean; onCreate(): void; onOpen(): void }): JSX.Element {
  const { t } = useI18n();
  const [app, setApp] = useState<AppId>("docs");
  const quota = useQuota(api, app === "accounts");
  return (
    <div className="app" data-panel="off">
      <header className="topbar">
        <div className="topbar-vault">
          <span className="topbar-brand">{t("app.name")}</span>
        </div>
        <div />
        <div className="topbar-actions">
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onOpen}>
            {t("vault.open")}
          </button>
          <LanguageSwitch />
        </div>
      </header>
      <ActivityBar active={app} changeCount={null} onSelect={setApp} />
      <main className="main">
        {app === "accounts" ? <AccountsView api={api} /> : <VaultEmpty {...props} />}
      </main>
      <StatusBar vault={null} quota={quota} onOpen={setApp} />
    </div>
  );
}
