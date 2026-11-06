import { useState } from "react";
import type { JSX } from "react";
import { Button, Disclosure, IconButton } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import type { Update } from "@/shell/useUpdate";

// Module scope: a remount (a vault switch) does not bring a dismissed card back for the same version.
const dismissed = new Set<string>();

/** Forgets every dismissal. For tests. */
export function resetUpdateCardForTests(): void {
  dismissed.clear();
}

/** A small card in the shell when an update is downloaded. Dismissing hides it for that version; the footer chip stays. */
export function UpdateCard(props: { update: Update | null; onRestart(): void }): JSX.Element | null {
  const { t } = useI18n();
  const [, bump] = useState(0);
  const { update } = props;
  if (!update || dismissed.has(update.version)) return null;
  const busy = update.status === "restarting";
  const notes = update.notes?.trim();
  return (
    <section className="ws-update-card" role="status" aria-label={t("update.card.title", { version: update.version })}>
      <div className="ws-update-card-head">
        <strong>{t("update.card.title", { version: update.version })}</strong>
        <IconButton
          icon="close"
          label={t("update.card.dismiss")}
          onClick={() => {
            dismissed.add(update.version);
            bump((n) => n + 1);
          }}
        />
      </div>
      <p className="ws-update-card-body">{update.status === "failed" ? t("status.updateFailed") : t("update.card.body")}</p>
      {notes && (
        <Disclosure title={t("update.card.notes")} defaultExpanded={false}>
          <p className="ws-update-card-notes">{notes}</p>
        </Disclosure>
      )}
      <Button type="button" data-act="update-restart" disabled={busy} onClick={props.onRestart}>
        {busy ? t("status.updating") : t("update.card.restart")}
      </Button>
    </section>
  );
}
