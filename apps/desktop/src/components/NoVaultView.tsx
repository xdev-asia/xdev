import { Button, Icon } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import { BrandMark } from "./BrandMark";
import type { JSX } from "react";
import { api, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import type { AppId } from "@/shell/apps";
import { useQuota } from "@/shell/useQuota";
import { AccountsView } from "./AccountsView";
import { ActivityBar } from "./ActivityBar";
import { AgentKitView, type KitHost } from "./AgentKitView";
import { LanguageSwitch } from "./LanguageSwitch";
import { SquadsView } from "./SquadsView";
import { StatusBar } from "./StatusBar";
import { TasksView } from "./TasksView";
import { useAppOrder, useHiddenApps, useVisibleApp } from "@/ui/hiddenApps";

export type VaultFailure = { path: string; code: ApiError["code"] };

export function VaultEmpty(props: { failure?: VaultFailure; busy: boolean; onCreate(): void; onOpen(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="vault-empty">
      <BrandMark className="vault-empty-logo" size={64} />
      <h1 className="vault-empty-title">{t("vault.empty.title")}</h1>
      {props.failure ? (
        <p className="error-text" role="alert">
          {t("vault.empty.failed", { path: props.failure.path })} {t(`error.${props.failure.code}`)}
        </p>
      ) : (
        <p className="vault-empty-hint">{t("vault.empty.hint")}</p>
      )}
      <div className="vault-empty-actions">
        <div className="vault-empty-card">
          <Icon name="folder" className="vault-empty-icon" />
          <p className="vault-empty-card-body">{t("vault.empty.openBody")}</p>
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onOpen}>
            {props.busy ? t("vault.opening") : t("vault.open")}
          </button>
        </div>
        <div className="vault-empty-card">
          <Icon name="plus" className="vault-empty-icon" />
          <p className="vault-empty-card-body">{t("vault.empty.createBody")}</p>
          <Button type="button" disabled={props.busy} onClick={props.onCreate}>
            {t("vault.create")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The workbench before any folder is open: Accounts, Tasks and Squads work, the folder apps explain how to get one. */
export function NoVaultView(props: { failure?: VaultFailure; busy: boolean; kit?: KitHost; appRequest?: { app: AppId; seq: number } | null; onCreate(): void; onOpen(): void }): JSX.Element {
  const { t } = useI18n();
  const [app, setApp] = useState<AppId>("docs");
  const hiddenApps = useHiddenApps();
  const appOrder = useAppOrder();
  useVisibleApp(app, hiddenApps, setApp, appOrder);
  const [taskFocus, setTaskFocus] = useState<string | null>(null);
  const { quota } = useQuota(api, app === "accounts");
  const kitRequest = props.kit?.open ?? null;
  useEffect(() => {
    if (kitRequest) setApp("kit");
  }, [kitRequest]);
  const appSeq = props.appRequest?.seq;
  useEffect(() => {
    if (props.appRequest) setApp(props.appRequest.app);
    // Only a new request runs this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSeq]);
  return (
    <div className="app" data-panel="off">
      <header className="topbar">
        <div className="topbar-vault">
          <BrandMark className="topbar-logo" size={20} />
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
      <ActivityBar active={app} changeCount={null} onSelect={setApp} hidden={hiddenApps} order={appOrder} />
      <main className="main">
        {app === "accounts" ? (
          <AccountsView api={api} />
        ) : app === "tasks" ? (
          // A task names its own repo, so it needs no docs folder.
          <TasksView key={taskFocus ?? ""} api={api} initial={taskFocus ?? undefined} />
        ) : app === "kit" ? (
          <AgentKitView
            api={api}
            worktree={props.kit?.worktree ?? null}
            request={props.kit?.open}
            onRequestHandled={props.kit?.onOpened}
            onSendToAgent={props.kit?.onSendToAgent}
            canSend={props.kit?.canSend}
          />
        ) : app === "squads" ? (
          <SquadsView
            api={api}
            onOpenTask={(id) => {
              setTaskFocus(id);
              setApp("tasks");
            }}
          />
        ) : (
          <VaultEmpty {...props} />
        )}
      </main>
      <StatusBar vault={null} quota={quota} onOpen={setApp} />
    </div>
  );
}
