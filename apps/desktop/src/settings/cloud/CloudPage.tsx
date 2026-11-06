import type { JSX } from "react";
import { useI18n } from "@/i18n";
import type { SettingsSectionProps } from "../sections";
import { ServerPanel } from "./ServerPanel";

/** Settings → Cloud: the server the license and xDev ID talk to. */
export function CloudPage({ api, filter }: SettingsSectionProps): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("cloud.title")}</h3>
      </header>
      <ServerPanel api={api} filter={filter} />
    </div>
  );
}
