import { Coachmark } from "@xdev-asia/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { getWallState, wallHasNew } from "@/featureWall/featureWallStore";
import { calmWait, claimInterruption, lastInputAt } from "./interruptions";
import { isFirstRun } from "./onboardingState";
import { useOnboarding } from "./onboardingStore";
import { loadSeen, markSeen, shouldStart, stepToShow, TOUR_STEPS } from "./tourModel";
import { useReplayToken } from "./tourStore";

const hasAnchor = (selector: string): boolean => document.querySelector(selector) !== null;
/** xterm.js puts `.xterm` on every terminal it draws. */
const terminalOnScreen = (): boolean => document.querySelector(".xterm") !== null;

/**
 * The two-step coachmark tour. Shows once per install after onboarding, when a terminal is on screen
 * (and each time "Replay tour" asks); Skip tour, Esc and Done all keep `tour.seen`.
 */
export function Tour(props: { api: Pick<Api, "uiSettingsGet" | "uiSettingsPut"> }): JSX.Element | null {
  const { api } = props;
  const { t } = useI18n();
  const onboarding = useOnboarding();
  const replay = useReplayToken();
  const [seen, setSeen] = useState<boolean | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const handled = useRef(0);
  const paneSince = useRef<number | null>(null);

  useEffect(() => {
    let stale = false;
    void loadSeen(api).then((v) => !stale && setSeen(v));
    return () => {
      stale = true;
    };
  }, [api]);

  const blocked = onboarding.wizardOpen || isFirstRun(onboarding.saved);

  // Starts on the first terminal, or on a new replay request.
  useEffect(() => {
    const wanted = replay !== handled.current;
    const tryStart = (): void => {
      const terminal = terminalOnScreen();
      if (!terminal) paneSince.current = null;
      else paneSince.current ??= Date.now();
      const calm = calmWait({ now: Date.now(), lastInput: lastInputAt(), paneSince: paneSince.current }) === 0;
      if (!shouldStart({ seen, replay: wanted, onboarding: blocked, terminal, running: index !== null, calm })) return;
      // A replay is asked for; the first tour takes the launch's one slot, or waits for the next start.
      if (!wanted && !claimInterruption("tour", wallHasNew(getWallState()) ? ["wall"] : [])) return;
      handled.current = replay;
      setIndex(0);
    };
    tryStart();
    if (index !== null || blocked || seen === null || (seen && !wanted)) return;
    // The terminal may open later, and the person may stop typing: look again while the DOM changes and on a timer.
    const observer = new MutationObserver(tryStart);
    observer.observe(document.body, { childList: true, subtree: true });
    const poll = setInterval(tryStart, 500);
    return () => {
      observer.disconnect();
      clearInterval(poll);
    };
  }, [seen, replay, blocked, index]);

  const finish = useCallback((): void => {
    setIndex(null);
    setRect(null);
    setSeen(true);
    void markSeen(api);
  }, [api]);

  // Measures the anchor of the current step, again on resize, scroll and DOM changes; a lost anchor ends the tour.
  useEffect(() => {
    if (index === null) return;
    const measure = (): void => {
      const step = stepToShow(index, hasAnchor);
      if (!step) return finish();
      setRect(document.querySelector(step.anchor)!.getBoundingClientRect());
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [index, finish]);

  if (index === null || blocked) return null;
  const step = stepToShow(index, hasAnchor);
  if (!step) return null;
  const last = index >= TOUR_STEPS.length - 1;
  return (
    <Coachmark
      anchor={rect}
      placement={step.placement}
      title={t(step.titleKey)}
      step={index + 1}
      total={TOUR_STEPS.length}
      onBack={index > 0 ? () => setIndex(index - 1) : undefined}
      onNext={() => (last ? finish() : setIndex(index + 1))}
      onSkip={finish}
      labels={{ back: t("tour.back"), next: t("tour.next"), done: t("tour.done"), skip: t("tour.skip"), step: (c, n) => t("tour.step", { current: c, total: n }) }}
    >
      {t(step.bodyKey)}
    </Coachmark>
  );
}
