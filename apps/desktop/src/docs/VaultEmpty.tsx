import { Button, EmptyState, Icon } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { ApiError } from "@/api";
import { BrandMark } from "@/components/BrandMark";
import { useI18n } from "@/i18n";

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
          <Button type="button" disabled={props.busy} onClick={props.onOpen}>
            {props.busy ? t("vault.opening") : t("vault.open")}
          </Button>
        </div>
        <div className="vault-empty-card">
          <Icon name="plus" className="vault-empty-icon" />
          <p className="vault-empty-card-body">{t("vault.empty.createBody")}</p>
          <Button variant="primary" type="button" disabled={props.busy} onClick={props.onCreate}>
            {t("vault.create")}
          </Button>
        </div>
      </div>
      <EmptyState
        className="vault-empty-steps"
        title={t("vault.steps.title")}
        steps={[{ label: t("vault.steps.open") }, { label: t("vault.steps.work") }, { label: t("vault.steps.approve") }]}
        current={1}
        labels={{ done: t("vault.steps.done"), step: (current, total) => t("vault.steps.step", { current, total }), steps: t("vault.steps.title") }}
      />
    </div>
  );
}
