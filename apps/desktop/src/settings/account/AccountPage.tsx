import { Avatar, Banner, Button, Disclosure, Field, FieldMessage, Spinner } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { XdevIdState } from "@xdev/bindings";
import { toApiError, type ApiError } from "@/api";
import { useI18n } from "@/i18n";
import { SettingRow } from "../SettingRow";
import type { SettingsSectionProps } from "../sections";
import { ServerRow } from "./ServerRow";
import { RoutingSection } from "./RoutingSection";

/**
 * Settings → Account: the person's xDev ID, and how agent tabs pick among the CLI accounts.
 * The xDev ID is display only: every local feature works signed out.
 * The state comes from Rust; the token never reaches this page.
 */
export function AccountPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [state, setState] = useState<XdevIdState | null>(null);
  // A failed sign in, sign out or manage; the next state change clears it.
  const [error, setError] = useState<ApiError["code"]>();
  const [pasteError, setPasteError] = useState<ApiError["code"]>();
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const apply = (next: XdevIdState): void => {
      if (!live) return;
      setCopied(false);
      setState(next);
      setError(undefined);
      setPasteError(undefined);
    };
    void api.xdevIdState().then(
      (s) => live && setState(s),
      () => undefined,
    );
    void api.onXdevIdChanged(apply).then((off) => {
      if (live) stop = off;
      else off();
    });
    // The service renews the session on this call; a failure keeps what is shown.
    // Its answer is the current state: the read above may predate the keychain load, and the
    // change event may fire before the listener is attached.
    void api.xdevIdRefresh().then(
      (s) => live && setState(s),
      () => undefined,
    );
    return () => {
      live = false;
      stop?.();
    };
  }, [api]);

  function run(call: () => Promise<XdevIdState>): void {
    setError(undefined);
    setCopied(false);
    call().then(setState, (e: unknown) => setError(toApiError(e).code));
  }

  function copy(link: string): void {
    void navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      () => undefined,
    );
  }

  function submitPaste(e: FormEvent): void {
    e.preventDefault();
    setPasteError(undefined);
    api.xdevIdPaste(pasted).then(
      (s) => {
        setState(s);
        setPasted("");
      },
      (err: unknown) => setPasteError(toApiError(err).code),
    );
  }

  const header = (
    <header className="settings-head">
      <h3>{t("account.title")}</h3>
    </header>
  );
  if (!state) return <div className="settings-page">{header}</div>;

  return (
    <div className="settings-page">
      {header}
      {state.state === "signedOut" && state.notice && <Banner title={t(`error.${state.notice}`)} />}
      {error && <Banner title={t(`error.${error}`)} />}
      <SettingRow id="account.xdevId" filter={filter}>
        <div className="settings-card" data-state={state.state}>
          {state.state === "signedOut" && (
            <>
              <div className="settings-item-text">
                <strong>{t("account.xdevId")}</strong>
                <span>{t("account.about")}</span>
              </div>
              <div className="settings-actions">
                <Button type="button" onClick={() => run(() => api.xdevIdSignIn())}>
                  {t("account.signIn")}
                </Button>
              </div>
            </>
          )}
          {state.state === "signingIn" && (
            <>
              <div className="settings-item-text">
                <strong>
                  <Spinner label={t("account.waiting.title")} /> {t("account.waiting.title")}
                </strong>
                <span>{t("account.waiting.body")}</span>
              </div>
              <div className="settings-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void api.xdevIdReopen().catch((e: unknown) => setError(toApiError(e).code))}
                >
                  {t("account.openAgain")}
                </Button>
                <Button type="button" variant="secondary" onClick={() => copy(state.link)}>
                  {t("account.copyLink")}
                </Button>
                <Button type="button" variant="secondary" onClick={() => run(() => api.xdevIdCancel())}>
                  {t("account.cancel")}
                </Button>
              </div>
              {copied && (
                <span className="settings-hint" role="status">
                  {t("account.copied")}
                </span>
              )}
              <Disclosure title={t("account.paste.toggle")} defaultExpanded={false}>
                <form onSubmit={submitPaste}>
                  <Field
                    label={t("account.paste.label")}
                    hint={t("account.paste.hint")}
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {pasteError && <FieldMessage>{t(`error.${pasteError}`)}</FieldMessage>}
                  <Button type="submit">{t("account.paste.submit")}</Button>
                </form>
              </Disclosure>
            </>
          )}
          {state.state === "signedIn" && (
            <>
              <Avatar name={state.user.name} src={state.user.avatar} size="lg" />
              <div className="settings-item-text">
                <strong>{state.user.name}</strong>
                <span>{state.user.email}</span>
              </div>
              <div className="settings-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void api.xdevIdManage().catch((e: unknown) => setError(toApiError(e).code))}
                >
                  {t("account.manage")}
                </Button>
                <Button type="button" variant="secondary" onClick={() => run(() => api.xdevIdSignOut())}>
                  {t("account.signOut")}
                </Button>
              </div>
            </>
          )}
        </div>
      </SettingRow>
      <ServerRow api={api} filter={filter} signedIn={state.state === "signedIn"} />
      <RoutingSection api={api} filter={filter} />
    </div>
  );
}
