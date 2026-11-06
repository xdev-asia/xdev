import { Coachmark } from "@xdev-asia/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { getWallState, wallHasNew } from "@/featureWall/featureWallStore";
import { useI18n } from "@/i18n";
import { calmWait, claimInterruption, lastInputAt } from "./interruptions";
import { FEATURE_TOURS, liveSteps, loadSeenTours, markTourSeen, tourMayStart, typingInTerminal, type FeatureTourId } from "./featureTours";
import { useFeatureTourToken } from "./featureTourStore";
import type { TourStep } from "./tourModel";

/** An anchor counts when it is drawn: a hidden view keeps its parts in the DOM with no box. */
const drawn = (selector: string): boolean => {
  const el = document.querySelector(selector);
  return el !== null && el.getClientRects().length > 0;
};

/**
 * Mount it inside the feature. The tour starts the first time the feature shows its anchors (and on each
 * "Replay feature tours"), once the keyboard is out of a terminal. Skip, Esc and Done all keep it as seen.
 */
export function FeatureTour(props: { tour: FeatureTourId }): JSX.Element | null {
  const { tour } = props;
  const { t } = useI18n();
  const replay = useFeatureTourToken();
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const running = steps !== null;

  useEffect(() => {
    if (running) return;
    /** True when there is nothing more to wait for: the tour started, or it was seen. */
    const tryStart = (): boolean => {
      const seen = loadSeenTours().has(tour);
      if (seen) return true;
      const calm = calmWait({ now: Date.now(), lastInput: lastInputAt(), paneSince: null }) === 0;
      if (!tourMayStart({ seen, running: false, typing: typingInTerminal(document.activeElement), calm })) return false;
      const live = liveSteps(FEATURE_TOURS[tour], drawn);
      if (live.length === 0) return false;
      // A replay is asked for (`replay` > 0 after "Replay feature tours"); otherwise one slot per launch.
      if (replay === 0 && !claimInterruption("tour", wallHasNew(getWallState()) ? ["wall"] : [])) return false;
      markTourSeen(tour);
      setIndex(0);
      setSteps(live);
      return true;
    };
    if (tryStart()) return;
    // The anchors may show later (a hidden view opens), and the keyboard may leave the terminal.
    const observer = new MutationObserver(() => void (tryStart() && observer.disconnect()));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    const onBlur = (): void => void (tryStart() && observer.disconnect());
    document.addEventListener("focusout", onBlur);
    const poll = setInterval(() => void (tryStart() && clearInterval(poll)), 500);
    return () => {
      clearInterval(poll);
      observer.disconnect();
      document.removeEventListener("focusout", onBlur);
    };
  }, [tour, running, replay]);

  const finish = useCallback((): void => {
    setSteps(null);
    setRect(null);
  }, []);

  // Esc closes the tour only: a dialog around it keeps its own Esc for the next press.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [running]);

  // Measures the current anchor, again on resize and scroll; a lost anchor skips its step.
  useEffect(() => {
    if (!steps) return;
    const measure = (): void => {
      const current = steps[index];
      const el = current ? document.querySelector(current.anchor) : null;
      if (!current || !el || el.getClientRects().length === 0) {
        if (index + 1 < steps.length) setIndex(index + 1);
        else finish();
        return;
      }
      setRect(el.getBoundingClientRect());
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [steps, index, finish]);

  const current = steps?.[index];
  if (!steps || !current || !rect) return null;
  const last = index >= steps.length - 1;
  return (
    <Coachmark
      anchor={rect}
      placement={current.placement}
      title={t(current.titleKey)}
      step={index + 1}
      total={steps.length}
      onBack={index > 0 ? () => setIndex(index - 1) : undefined}
      onNext={() => (last ? finish() : setIndex(index + 1))}
      onSkip={finish}
      labels={{ back: t("tour.back"), next: t("tour.next"), done: t("tour.done"), skip: t("tour.skip"), step: (c, n) => t("tour.step", { current: c, total: n }) }}
    >
      {t(current.bodyKey)}
    </Coachmark>
  );
}
