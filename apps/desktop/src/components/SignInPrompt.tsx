import { Button, Dialog, PairingCode } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

export interface SignInPromptProps {
  /** The account being signed in. */
  name: string;
  /** The sign-in page; absent until the CLI has printed it. */
  url?: string;
  /** The one-time code of a device flow. */
  code?: string;
  /** Set when the sign-in failed; the CLI's last output, possibly empty. */
  error?: string;
  copy?: "copied" | "copyFailed";
  onOpen(): void;
  onCopyLink(): void;
  onCopyCode(): void;
  /** Stops the sign-in. */
  onCancel(): void;
  /** Closes the dialog after a failure. */
  onClose(): void;
}

/** The sign-in of one account, run on this machine: the page to open and the code to type there. */
export function SignInPrompt(props: SignInPromptProps): JSX.Element {
  const { t } = useI18n();
  const failed = props.error !== undefined;
  return (
    <Dialog
      modal
      title={t("accounts.signIn.title", { name: props.name })}
      confirmLabel={failed ? t("accounts.signIn.close") : t("accounts.signIn.open")}
      cancelLabel={failed ? null : t("accounts.signIn.cancel")}
      confirmDisabled={!failed && props.url === undefined}
      onConfirm={failed ? props.onClose : props.onOpen}
      onCancel={failed ? props.onClose : props.onCancel}
    >
      <div className="signin-prompt" data-signin={failed ? "failed" : props.url ? "ready" : "waiting"}>
        {failed ? (
          <>
            <p role="alert">{t("accounts.signIn.failed")}</p>
            {props.error && <pre className="commands signin-output">{props.error}</pre>}
          </>
        ) : props.url === undefined ? (
          <p role="status">{t("accounts.signIn.waiting")}</p>
        ) : (
          <>
            <p>{t("accounts.signIn.steps")}</p>
            {props.code && (
              <>
                <p>{t("accounts.signIn.code")}</p>
                <PairingCode value={props.code} groupSize={4} label={t("accounts.signIn.codeLabel")} copyLabel={t("accounts.signIn.copyCode")} onCopy={props.onCopyCode} size="md" />
              </>
            )}
            <Button type="button" variant="secondary" onClick={props.onCopyLink}>{t("accounts.signIn.copyLink")}</Button>
            {props.copy && <span role="status">{t(`connect.${props.copy}`)}</span>}
          </>
        )}
      </div>
    </Dialog>
  );
}
