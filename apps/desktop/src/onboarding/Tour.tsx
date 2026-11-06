import { Coachmark } from "@xdev-asia/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
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
      if (shouldStart({ seen, replay: wanted, onboarding: blocked, terminal: terminalOnScreen(), running: index !== null })) {
        handled.current = replay;
        setIndex(0);
      }
    };
    tryStart();
    if (index !== null || blocked || seen === null || (seen && !wanted)) return;
    // The terminal may open later: look again while the DOM changes.
    const observer = new MutationObserver(tryStart);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
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
