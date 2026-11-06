import { Dialog } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { PeerConfirm as PeerConfirmEvent } from "@/api";
import { useI18n } from "@/i18n";
import { confirmAction } from "./peersModel";

/** A paired computer asks to do something here and the setting says to ask first. Deny is the way out (Esc too). */
export function PeerConfirm(props: { request: PeerConfirmEvent; onReply(allow: boolean): void }): JSX.Element {
  const { t } = useI18n();
  const { request: r } = props;
  return (
    <Dialog
      modal
      alert
      title={t("peers.confirm.title", { computer: r.peer, action: confirmAction(t, r.action) })}
      confirmLabel={t("peers.confirm.allow")}
      cancelLabel={t("peers.confirm.deny")}
      onConfirm={() => props.onReply(true)}
      onCancel={() => props.onReply(false)}
    >
      <span className="ws-mono">{r.target}</span>
    </Dialog>
  );
}
