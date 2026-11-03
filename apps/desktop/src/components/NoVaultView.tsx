import { Button } from "@xdev/ui";
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

export type VaultFailure = { path: string; code: ApiError["code"] };

const ICON = {
  className: "vault-empty-icon",
  "aria-hidden": true,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function FolderIcon(): JSX.Element {
  return (
    <svg {...ICON}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function PlusIcon(): JSX.Element {
  return (
    <svg {...ICON}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

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
          <FolderIcon />
          <p className="vault-empty-card-body">{t("vault.empty.openBody")}</p>
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onOpen}>
            {props.busy ? t("vault.opening") : t("vault.open")}
          </button>
        </div>
        <div className="vault-empty-card">
          <PlusIcon />
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
export function NoVaultView(props: { failure?: VaultFailure; busy: boolean; kit?: KitHost; onCreate(): void; onOpen(): void }): JSX.Element {
  const { t } = useI18n();
  const [app, setApp] = useState<AppId>("docs");
  const [taskFocus, setTaskFocus] = useState<string | null>(null);
  const quota = useQuota(api, app === "accounts");
  const kitRequest = props.kit?.open ?? null;
  useEffect(() => {
    if (kitRequest) setApp("kit");
  }, [kitRequest]);
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
      <ActivityBar active={app} changeCount={null} onSelect={setApp} />
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
