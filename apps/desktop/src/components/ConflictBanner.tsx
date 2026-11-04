import { Button } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { WarnIcon } from "./FreshnessBanner";

export function ConflictBanner(props: { onReload(): void; onKeep(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="banner banner-warn" role="alert">
      <WarnIcon />
      <div className="banner-text">
        <strong>{t("conflict.title")}</strong>
        <span>{t("conflict.body")}</span>
      </div>
      <div className="banner-actions">
        <button type="button" className="btn-secondary" onClick={props.onReload}>
          {t("conflict.reload")}
        </button>
        <Button type="button" onClick={props.onKeep}>
          {t("conflict.keep")}
        </Button>
      </div>
    </div>
  );
}
