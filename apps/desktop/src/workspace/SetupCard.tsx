import type { JSX } from "react";
import { useI18n } from "@/i18n";

/** What the card says; the shell picks one per worktree. */
export type SetupCardState =
  /** No setup script, but a command was guessed from the files. */
  | { kind: "detected"; command: string }
  /** A setup script exists and the repo's policy is Ask. */
  | { kind: "ask" }
  /** An agent launch waits for the setup tab to exit. */
  | { kind: "waiting" }
  /** The setup tab exited with a failure. */
  | { kind: "failed"; code: number | null };

// A non-modal panel at the top of the worktree's terminal area. Bordered, with no coloured stripe.
export function SetupCard(props: {
  state: SetupCardState;
  onSave(): void;
  onConfigure(): void;
  onDismiss(): void;
  onRun(): void;
  onSkip(): void;
  onAlways(): void;
  /** Starts the waiting agent now; also "Start anyway" after a failure. */
  onStartNow(): void;
  onOpenSetup(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { state } = props;
  const button = (label: string, onClick: () => void): JSX.Element => (
    <button type="button" className="btn-secondary" onClick={onClick}>
      {label}
    </button>
  );
  return (
    <section className="ws-setup-card" aria-label={t("setup.card.label")}>
      {state.kind === "detected" && (
        <>
          <p>{t("setup.card.detected")}</p>
          <code className="ws-mono">{state.command}</code>
          <div className="ws-setup-actions">
            {button(t("setup.card.save"), props.onSave)}
            {button(t("setup.card.configure"), props.onConfigure)}
            {button(t("setup.card.dismiss"), props.onDismiss)}
          </div>
        </>
      )}
      {state.kind === "ask" && (
        <>
          <p>{t("setup.card.ask")}</p>
          <div className="ws-setup-actions">
            {button(t("setup.card.run"), props.onRun)}
            {button(t("setup.card.skip"), props.onSkip)}
            {button(t("setup.card.always"), props.onAlways)}
          </div>
        </>
      )}
      {state.kind === "waiting" && (
        <>
          <p role="status">{t("setup.card.waiting")}</p>
          <div className="ws-setup-actions">{button(t("setup.card.startNow"), props.onStartNow)}</div>
        </>
      )}
      {state.kind === "failed" && (
        <>
          <p role="alert">{state.code === null ? t("setup.card.failedNoCode") : t("setup.card.failed", { code: state.code })}</p>
          <div className="ws-setup-actions">
            {button(t("setup.card.startAnyway"), props.onStartNow)}
            {button(t("setup.card.openSetup"), props.onOpenSetup)}
          </div>
        </>
      )}
    </section>
  );
}
