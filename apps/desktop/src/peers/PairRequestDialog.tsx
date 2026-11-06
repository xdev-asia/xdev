import { Dialog, Select } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { PeerPairRequest, PeerRole } from "@/api";
import { useI18n } from "@/i18n";
import { rolesFor } from "./peersModel";
import { SasCheck } from "./SasCheck";

/** The roles a new computer can start with: Admin is given later, from the list, after a typed confirm. */
export function startRoles(kind: PeerPairRequest["kind"]): PeerRole[] {
  return rolesFor(kind).filter((r) => r !== "none" && r !== "admin");
}

/** Another computer entered the code shown here: check the digits and pick what it may do. */
export function PairRequestDialog(props: { request: PeerPairRequest; onAnswer(accept: boolean, role: PeerRole): void }): JSX.Element {
  const { t } = useI18n();
  const { request: req } = props;
  const [role, setRole] = useState<PeerRole>("viewer");
  return (
    <Dialog
      modal
      title={t("peers.pair.request", { name: req.name })}
      confirmLabel={t("peers.pair.match")}
      cancelLabel={t("peers.pair.noMatch")}
      onConfirm={() => props.onAnswer(true, role)}
      onCancel={() => props.onAnswer(false, "none")}
      body="plain"
    >
      <div className="peers-pair" data-testid="pair-request">
        <SasCheck sas={req.sas} name={req.name} />
        <label className="peers-pair">
          <span>{t("peers.pair.role", { name: req.name })}</span>
          <Select
            aria-label={t("peers.pair.role", { name: req.name })}
            value={role}
            options={startRoles(req.kind).map((r) => ({ value: r, label: t(`peers.role.${r}`) }))}
            onChange={(e) => setRole(e.target.value as PeerRole)}
          />
        </label>
      </div>
    </Dialog>
  );
}
