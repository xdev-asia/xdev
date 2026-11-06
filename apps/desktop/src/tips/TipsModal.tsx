import { Button, Dialog } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type SkillStatus } from "@/api";
import { wallHasNew, useWallState } from "@/featureWall/featureWallStore";
import { useI18n } from "@/i18n";
import { typingInTerminal } from "@/onboarding/featureTours";
import { loadSeenTips, markTipSeen, nextTip, SETTLE_MS, TIPS, tipsGate, type Tip, type TipContext } from "./tipsModel";
import { markTipShownThisRun, setTipsEnabled, tipShownThisRun, useTipsEnabled } from "./tipsStore";

export type TipPhase = "idle" | "installing" | "done";

/** The modal: the tip, then "Next tip" and "Don't show tips"; one primary button, the tip's action or "Got it". */
export function TipsModalView(props: {
  tip: Tip;
  phase: TipPhase;
  /** An error code from the last action. */
  error?: string;
  /** Another tip is waiting. */
  hasNext: boolean;
  onAction(): void;
  onNext(): void;
  onDisable(): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { tip, phase } = props;
  const working = phase === "installing";
  const primary = phase === "done" ? t("tip.done") : tip.action ? (working ? t("tip.cliSkill.installing") : t(tip.action.labelKey)) : t("tip.close");
  return (
    <Dialog
      modal
      title={t(tip.titleKey)}
      cancelLabel={null}
      confirmLabel={primary}
      confirmDisabled={working}
      onConfirm={phase !== "done" && tip.action ? props.onAction : props.onClose}
      onCancel={props.onClose}
      body="plain"
    >
      <p className="tip-eyebrow">{t("tip.eyebrow")}</p>
      <p className="tip-text">{t(tip.bodyKey)}</p>
      {tip.exampleKey && (
        <>
          <p className="tip-text">{t("tip.cliSkill.try")}</p>
          <p className="ws-mono tip-example">{t(tip.exampleKey)}</p>
        </>
      )}
      {phase === "done" && <p className="settings-saved">{t("tip.cliSkill.installed")}</p>}
      {props.error && (
        <p className="error-text" role="alert">
          {t(`error.${props.error}`)}
        </p>
      )}
      <div className="settings-actions settings-actions-start tip-actions">
        {props.hasNext && (
          <Button type="button" variant="secondary" disabled={working} onClick={props.onNext}>
            {t("tip.next")}
          </Button>
        )}
        <Button type="button" variant="secondary" disabled={working} onClick={props.onDisable}>
          {t("tip.disable")}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Offers one tip per launch, once the start has settled and nothing else has the screen (`suppressed`: onboarding).
 * Each tip shown is remembered; "Don't show tips" turns them off until Settings → General turns them on.
 */
export function TipsHost(props: { api: Pick<Api, "orchestrationSkillStatus" | "orchestrationSkillInstall">; suppressed?: boolean }): JSX.Element | null {
  const wall = useWallState();
  // The what's new wall comes first: tips wait while it is open or about to open.
  const suppressed = (props.suppressed ?? false) || wall.open || wallHasNew(wall);
  const { api } = props;
  const enabled = useTipsEnabled();
  const [status, setStatus] = useState<SkillStatus | null>(null);
  const [settled, setSettled] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [phase, setPhase] = useState<TipPhase>("idle");
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const ctx: TipContext = { cliSkillInstalled: status === null ? null : status.installed };

  // A failed read leaves the status empty, so the skill tip stays back.
  useEffect(() => {
    let live = true;
    api.orchestrationSkillStatus().then(
      (s) => live && setStatus(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    if (suppressed) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [suppressed]);

  useEffect(() => {
    if (tip || !tipsGate({ enabled, shownThisRun: tipShownThisRun(), suppressed, settled })) return;
    // A tip never takes the keyboard from a terminal: it waits for the focus to leave.
    if (typingInTerminal(document.activeElement)) {
      const again = (): void => setRetry((n) => n + 1);
      document.addEventListener("focusout", again, { once: true });
      return () => document.removeEventListener("focusout", again);
    }
    const first = nextTip(TIPS, loadSeenTips(), ctx);
    if (!first) return;
    markTipSeen(first.id);
    markTipShownThisRun();
    setTip(first);
    // `ctx` is read as of now; it is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip, enabled, suppressed, settled, retry, status]);

  const close = (): void => {
    setTip(null);
    setPhase("idle");
    setError(undefined);
  };

  async function runAction(): Promise<void> {
    setPhase("installing");
    setError(undefined);
    try {
      setStatus(await api.orchestrationSkillInstall());
      setPhase("done");
    } catch (e) {
      setError(toApiError(e).code);
      setPhase("idle");
    }
  }

  if (!tip) return null;
  const seen = loadSeenTips();
  seen.add(tip.id);
  const following = nextTip(TIPS, seen, ctx);
  return (
    <TipsModalView
      tip={tip}
      phase={phase}
      error={error}
      hasNext={following !== null}
      onAction={() => void runAction()}
      onNext={() => {
        if (!following) return close();
        markTipSeen(following.id);
        setPhase("idle");
        setError(undefined);
        setTip(following);
      }}
      onDisable={() => {
        setTipsEnabled(false);
        close();
      }}
      onClose={close}
    />
  );
}
