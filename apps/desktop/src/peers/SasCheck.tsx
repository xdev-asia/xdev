import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { PairingCode } from "./standins/PairingCode";

/** The six digits both computers must show. The answer buttons are the dialog's own, so a surface keeps one primary. */
export function SasCheck(props: {
  sas: string;
  name: string;
  /** Set once this computer answered: the line says it waits for the other one. */
  waiting?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="peers-pair" data-testid="peers-sas">
      <PairingCode value={props.sas} groupSize={3} label={t("peers.pair.sas", { sas: props.sas })} size="lg" />
      {props.waiting ? <p role="status">{t("peers.pair.waiting", { name: props.name })}</p> : <p>{t("peers.pair.sas", { sas: props.sas })}</p>}
    </div>
  );
}
