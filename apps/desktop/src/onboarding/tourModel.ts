// The first-terminal coachmark tour: which steps there are and when the tour may show. Pure, so it tests without a DOM.

import type { Api } from "@/api";
import type { CoachmarkPlacement } from "@xdev-asia/ui";

export interface TourStep {
  id: string;
  /** CSS selector of the part the card points at. */
  anchor: string;
  placement: CoachmarkPlacement;
  titleKey: string;
  bodyKey: string;
}

/** Marks the parts the tour points at: `data-tour="layout"` and `data-tour="tab-add"`. */
export const TOUR_STEPS: readonly TourStep[] = [
  { id: "split", anchor: '[data-tour="layout"]', placement: "bottom", titleKey: "tour.split.title", bodyKey: "tour.split.body" },
  { id: "agent", anchor: '[data-tour="tab-add"]', placement: "bottom", titleKey: "tour.agent.title", bodyKey: "tour.agent.body" },
];

export interface TourGate {
  /** `tour.seen` is not read yet: null. */
  seen: boolean | null;
  /** Replay was asked for: shows even when seen. */
  replay: boolean;
  /** The wizard is open (first run, or resumed over the app). */
  onboarding: boolean;
  /** The first terminal tab is on screen. */
  terminal: boolean;
  /** The tour is already running. */
  running: boolean;
  /** The person is idle and the terminal is not brand new. A replay does not wait for it. */
  calm: boolean;
}

/** Whether to start the tour now. A run in progress is never restarted. */
export function shouldStart(g: TourGate): boolean {
  if (g.running || g.onboarding || !g.terminal || g.seen === null) return false;
  if (g.replay) return true;
  return !g.seen && g.calm;
}

/** The step to show, or null when the tour ends: a missing anchor ends it (no card pointing at nothing). */
export function stepToShow(index: number, has: (selector: string) => boolean): TourStep | null {
  const step = TOUR_STEPS[index];
  return step && has(step.anchor) ? step : null;
}

type SeenApi = Pick<Api, "uiSettingsGet" | "uiSettingsPut">;

/** `tour.seen` as stored; false when it cannot be read, so a first run still shows. */
export async function loadSeen(api: SeenApi): Promise<boolean> {
  try {
    return (await api.uiSettingsGet()).tourSeen;
  } catch {
    return false;
  }
}

/** Keeps `tour.seen`, whether the tour was finished or skipped. */
export async function markSeen(api: SeenApi): Promise<void> {
  try {
    const ui = await api.uiSettingsGet();
    if (!ui.tourSeen) await api.uiSettingsPut({ ...ui, tourSeen: true });
  } catch {
    // Not stored: the tour may show once more on the next start.
  }
}
