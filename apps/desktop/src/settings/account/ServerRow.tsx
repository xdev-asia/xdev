import { Banner, Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { XdevIdServer } from "@xdev/bindings";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { SettingRow } from "../SettingRow";
import type { SettingsFilter } from "../sections";

type Props = {
  api: Pick<Api, "xdevIdServer">;
  filter?: SettingsFilter;
  /** Opens another settings section; without it the row has nothing to press. */
  openSection?(id: string): void;
};

/**
 * Settings → xDev ID → xDev server: the server in use and where it comes from. Read only:
 * the one xDev server setting is edited in Settings → Cloud, beside its trusted keys.
 */
export function ServerRow({ api, filter, openSection }: Props): JSX.Element {
  const { t } = useI18n();
  const [server, setServer] = useState<XdevIdServer | null>(null);

  useEffect(() => {
    let live = true;
    void api.xdevIdServer().then(
      (s) => {
        if (live) setServer(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (!server) return <></>;
  return (
    <SettingRow id="account.server" filter={filter}>
      <div className="settings-card" data-setting="server">
        <div className="settings-item-text">
          <strong>{t("account.server.title")}</strong>
          <span>{t("account.server.current", { origin: server.origin })}</span>
          <span className="settings-hint">{t(`account.server.source.${server.source}`)}</span>
          <span className="settings-hint">{t("account.server.hint")}</span>
        </div>
        {server.invalid && <Banner title={t("account.server.invalid")} />}
        {openSection && (
          <div className="settings-actions">
            <Button type="button" variant="secondary" onClick={() => openSection("cloud")}>
              {t("account.server.change")}
            </Button>
          </div>
        )}
      </div>
    </SettingRow>
  );
}
