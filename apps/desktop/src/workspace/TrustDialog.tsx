import { Button } from "@xdev-asia/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { ApiError, DefaultTab, HookKind } from "@/api";
import { useI18n } from "@/i18n";

// Mounted only while open. Shows the exact text of a shared script from the repo file: trust covers
// that text, and the person has to see it first.
export function TrustDialog(props: {
  repo: string;
  /** The repo file the script comes from. */
  file: string;
  /** A script of the repo file, the `[[commands]]` list, or only the shared paths and tabs. */
  kind: HookKind | "commands" | "lists";
  text: string;
  /** Shared paths and default tabs that are asked about together with the script. */
  shared?: string[];
  tabs?: DefaultTab[];
  /** The dialog reopened because the script changed after it was last shown. */
  changed: boolean;
  busy: boolean;
  error?: ApiError["code"];
  onTrust(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const shared = props.shared ?? [];
  const tabs = props.tabs ?? [];

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-trust-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="ws-trust-title" className="dialog-title">
        {props.kind === "commands" ? t("qcmd.trust.title") : props.kind === "lists" ? t("repoFile.trust.title") : t("setup.trust.title", { kind: t(`setup.kind.${props.kind}`) })}
      </h2>
      <p className="dialog-body">
        {props.kind === "commands" ? t("qcmd.trust.body", { repo: props.repo, file: props.file }) : props.kind === "lists" ? t("repoFile.trust.body", { repo: props.repo, file: props.file }) : t("setup.trust.body", { repo: props.repo, file: props.file })}
      </p>
      {props.changed && <p className="dialog-body">{t("setup.trust.changed")}</p>}
      {props.kind !== "lists" && <pre className="ws-mono ws-script" tabIndex={0}>{props.text}</pre>}
      {shared.length > 0 && (
        <>
          <p className="dialog-body"><strong>{t("repoFile.shared")}</strong></p>
          <p className="dialog-body">{t("repoFile.sharedHint")}</p>
          <pre className="ws-mono ws-script" tabIndex={0}>{shared.join("\n")}</pre>
        </>
      )}
      {tabs.length > 0 && (
        <>
          <p className="dialog-body"><strong>{t("repoFile.tabs")}</strong></p>
          <p className="dialog-body">{t("repoFile.tabsHint")}</p>
          <pre className="ws-mono ws-script" tabIndex={0}>{tabs.map((x) => t("repoFile.tab.item", { title: x.title, command: x.command })).join("\n")}</pre>
        </>
      )}
      <p className="dialog-body">{props.kind === "lists" ? t("repoFile.trust.note") : t("setup.trust.note")}</p>
      {props.error && (
        <p className="error-text" role="alert">
          {t(`error.${props.error}`)}
        </p>
      )}
      <div className="dialog-actions">
        {/* Cancel first and focused: trusting is a deliberate click. */}
        <button type="button" className="btn-secondary" autoFocus onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
        <Button variant="primary" type="button" disabled={props.busy} onClick={props.onTrust}>
          {props.kind === "commands" ? t("qcmd.trust.confirm") : props.kind === "lists" ? t("repoFile.trust.confirm") : t("setup.trust.confirm")}
        </Button>
      </div>
    </dialog>
  );
}
