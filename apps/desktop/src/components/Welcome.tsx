import { Button } from "@xdev/ui";
import type { JSX } from "react";
import type { ApiError } from "../api";
import { useI18n } from "../i18n";
import { LanguageSwitch } from "./LanguageSwitch";

export function Welcome(props: { onOpen(): void; opening: boolean; error?: ApiError["code"] }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="welcome">
      <div className="welcome-lang">
        <LanguageSwitch />
      </div>
      <main className="welcome-card">
        <h1 className="welcome-title">{t("app.name")}</h1>
        <p className="welcome-tagline">{t("app.tagline")}</p>
        <p className="welcome-hint">{t("welcome.hint")}</p>
        <Button type="button" onClick={props.onOpen} disabled={props.opening}>
          {props.opening ? t("welcome.opening") : t("welcome.open")}
        </Button>
        {props.error && (
          <p className="error-text" role="alert">
            {t(`error.${props.error}`)}
          </p>
        )}
      </main>
    </div>
  );
}
