import { Button } from "@xdev/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Provider } from "@/api";
import { useI18n } from "@/i18n";

export interface SwitchRow {
  /** The tab's pty id. */
  id: string;
  label: string;
  /** Its turn is running: a restart ends it, so it starts unticked. */
  working: boolean;
}

// Mounted only while open: after the active account changed, the agent tabs that still run under the old one.
export function AccountSwitchDialog(props: {
  provider: Provider;
  /** The active account before and after; null is the CLI's own home. */
  from: string | null;
  to: string | null;
  rows: SwitchRow[];
  /** `remember`: "Don't ask again" was ticked, so the choice becomes the setting. */
  onRestart(ids: string[], remember: boolean): void;
  onKeep(remember: boolean): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(props.rows.filter((r) => !r.working).map((r) => r.id)));
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const name = (account: string | null) => account ?? t("accounts.switch.cliDefaultName");
  const toggle = (id: string, on: boolean) =>
    setPicked((before) => {
      const next = new Set(before);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const ids = props.rows.filter((r) => picked.has(r.id)).map((r) => r.id);

  return (
    <dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      className="dialog ws-dialog"
      aria-labelledby="ws-switch-title"
      onCancel={(e) => {
        e.preventDefault();
        // Escape leaves the tabs and does not store a choice.
        props.onKeep(false);
      }}
    >
      <h2 id="ws-switch-title" className="dialog-title">
        {t("accounts.switch.dialog.title")}
      </h2>
      <p className="dialog-body">
        {t("accounts.switch.dialog.body", { provider: t(`accounts.provider.${props.provider}`), from: name(props.from), to: name(props.to) })}
      </p>
      <p className="dialog-body">{t("accounts.switch.dialog.note")}</p>
      <ul className="ws-switch-list">
        {props.rows.map((r) => (
          <li key={r.id}>
            <label className="ws-switch-row">
              <input type="checkbox" data-action={`switch-tab-${r.id}`} checked={picked.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
              <span>{r.label}</span>
              {r.working && <span className="ws-switch-working">{t("accounts.switch.dialog.working")}</span>}
            </label>
          </li>
        ))}
      </ul>
      <label className="ws-switch-row">
        <input type="checkbox" data-action="switch-remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>{t("accounts.switch.dialog.remember")}</span>
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" data-action="switch-keep" onClick={() => props.onKeep(remember)}>
          {t("accounts.switch.dialog.keep")}
        </button>
        <Button type="button" autoFocus data-action="switch-restart" disabled={ids.length === 0} onClick={() => props.onRestart(ids, remember)}>
          {t("accounts.switch.dialog.restart")}
        </Button>
      </div>
    </dialog>
  );
}
