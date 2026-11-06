import { useState } from "react";
import type { JSX } from "react";
import { Button, Disclosure } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import type { Update } from "@/shell/useUpdate";
import { cardVisible, loadNudge, loadRemindDays, remindLater, saveNudge, skipVersion, type Nudge, type NudgeState } from "@/shell/updateNudge";

// Module scope: a remount (a vault switch) keeps what was put away. Storage keeps it across launches.
let away: NudgeState | null | undefined;

/** Forgets what was put away, here and in storage. For tests. */
export function resetUpdateCardForTests(store?: Nudge["store"]): void {
  away = undefined;
  try {
    (store ?? localStorage).setItem("xdev.update.nudge", "");
  } catch {
    // No storage to clear.
  }
}

/**
 * A small card in the shell when an update is downloaded; the footer chip stays. "Remind me later" brings the card back after
 * the delay set in Settings (3 days by default); "Skip this version" brings it back for a newer version only.
 * `nudge` passes the clock and the storage, so a test sets its own.
 */
export function UpdateCard(props: { update: Update | null; onRestart(): void; nudge?: Nudge }): JSX.Element | null {
  const { t } = useI18n();
  const [, bump] = useState(0);
  const { update } = props;
  const now = props.nudge?.now ?? Date.now;
  const store = props.nudge?.store;
  if (away === undefined) away = loadNudge(store);
  if (!update || !cardVisible(update.version, away, now())) return null;
  const putAway = (next: NudgeState): void => {
    away = next;
    saveNudge(next, store);
    bump((n) => n + 1);
  };
  const busy = update.status === "restarting";
  const notes = update.notes?.trim();
  return (
    <section className="ws-update-card" role="status" aria-label={t("update.card.title", { version: update.version })}>
      <div className="ws-update-card-head">
        <strong>{t("update.card.title", { version: update.version })}</strong>
      </div>
      <p className="ws-update-card-body">{update.status === "failed" ? t("status.updateFailed") : t("update.card.body")}</p>
      {notes && (
        <Disclosure title={t("update.card.notes")} defaultExpanded={false}>
          <p className="ws-update-card-notes">{notes}</p>
        </Disclosure>
      )}
      <div className="ws-update-card-actions">
        <Button type="button" data-act="update-restart" disabled={busy} onClick={props.onRestart}>
          {busy ? t("status.updating") : t("update.card.restart")}
        </Button>
        <Button type="button" variant="secondary" data-act="update-remind" onClick={() => putAway(remindLater(update.version, now(), loadRemindDays(store)))}>
          {t("update.card.remind")}
        </Button>
        <Button type="button" variant="secondary" data-act="update-skip" onClick={() => putAway(skipVersion(update.version))}>
          {t("update.card.skip")}
        </Button>
      </div>
    </section>
  );
}
