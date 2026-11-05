import { Banner, Button, Field, FieldMessage } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { XdevIdServer } from "@xdev/bindings";
import { toApiError, type Api, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import { SettingRow } from "../SettingRow";
import type { SettingsFilter } from "../sections";

type Props = {
  api: Pick<Api, "xdevIdServer" | "xdevIdServerSet">;
  filter?: SettingsFilter;
  /** A different server signs the person out first, so it asks. */
  signedIn: boolean;
};

/** Settings → xDev ID → Server: the on-prem address, and where the one in use comes from. */
export function ServerRow({ api, filter, signedIn }: Props): JSX.Element {
  const { t } = useI18n();
  const [server, setServer] = useState<XdevIdServer | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<ApiError["code"]>();
  // The value waiting for a yes, when saving it would sign the person out.
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.xdevIdServer().then(
      (s) => {
        if (!live) return;
        setServer(s);
        setText(s.setting);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  function apply(value: string): void {
    setError(undefined);
    setConfirm(null);
    api.xdevIdServerSet(value).then(
      (s) => {
        setServer(s);
        setText(s.setting);
      },
      (e: unknown) => setError(toApiError(e).code),
    );
  }

  /** The environment variable decides the server, so a save cannot switch it. */
  function request(value: string): void {
    const next = value.trim();
    if (signedIn && server?.source !== "env" && next !== server?.setting) setConfirm(next);
    else apply(next);
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    request(text);
  }

  if (!server) return <></>;
  const dirty = text.trim() !== server.setting;
  return (
    <SettingRow id="account.server" filter={filter}>
      <div className="settings-card" data-setting="server">
        <div className="settings-item-text">
          <strong>{t("account.server.title")}</strong>
          <span>{t("account.server.current", { origin: server.origin })}</span>
          <span className="settings-hint">{t(`account.server.source.${server.source}`)}</span>
        </div>
        {server.invalid && <Banner title={t("account.server.invalid")} />}
        <form onSubmit={submit}>
          <Field
            label={t("account.server.label")}
            hint={t("account.server.hint")}
            value={text}
            placeholder="https://id.example.com"
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {error && <FieldMessage>{t(`error.${error}`)}</FieldMessage>}
          {confirm === null ? (
            <div className="settings-actions">
              <Button type="submit" variant="secondary" disabled={!dirty}>
                {t("account.server.save")}
              </Button>
              <Button type="button" variant="secondary" disabled={server.setting === ""} onClick={() => request("")}>
                {t("account.server.useDefault")}
              </Button>
            </div>
          ) : (
            <>
              <Banner title={t("account.server.confirm.title")}>{t("account.server.confirm.body", { origin: server.origin })}</Banner>
              <div className="settings-actions">
                <Button type="button" variant="secondary" onClick={() => apply(confirm)}>
                  {t("account.server.confirm.yes")}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setConfirm(null)}>
                  {t("account.server.confirm.no")}
                </Button>
              </div>
            </>
          )}
        </form>
      </div>
    </SettingRow>
  );
}
