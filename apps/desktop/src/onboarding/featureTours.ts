// Short tours a feature registers: they run the first time that feature is opened, once per user. Pure, so it tests without a DOM.

import type { TourStep } from "./tourModel";

export type FeatureTourId = "worktree" | "review" | "activity";

export interface FeatureTour {
  id: FeatureTourId;
  /** Two to four steps, anchored on `data-tour` attributes. */
  steps: readonly TourStep[];
}

const step = (tour: FeatureTourId, id: string, placement: TourStep["placement"] = "bottom"): TourStep => ({
  id,
  anchor: `[data-tour="${tour}-${id}"]`,
  placement,
  titleKey: `tour.${tour}.${id}.title`,
  bodyKey: `tour.${tour}.${id}.body`,
});

/** Marks: `worktree-name`, `worktree-base`, `worktree-agent`; `review-layout`, `review-notes`, `review-ai`; `activity-controls`, `activity-list`, `activity-mission`. */
export const FEATURE_TOURS: Readonly<Record<FeatureTourId, FeatureTour>> = {
  worktree: { id: "worktree", steps: [step("worktree", "name"), step("worktree", "base"), step("worktree", "agent")] },
  review: { id: "review", steps: [step("review", "layout"), step("review", "notes"), step("review", "ai")] },
  activity: { id: "activity", steps: [step("activity", "controls"), step("activity", "list"), step("activity", "mission", "top")] },
};

export const TOURS_SEEN_KEY = "xdev.tours.seen";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/** The tours already shown; empty when storage cannot be read, so a first run still shows. */
export function loadSeenTours(store: Store | null = defaultStore()): Set<string> {
  try {
    const raw: unknown = JSON.parse(store?.getItem(TOURS_SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function markTourSeen(id: FeatureTourId, store: Store | null = defaultStore()): void {
  try {
    const seen = loadSeenTours(store);
    seen.add(id);
    store?.setItem(TOURS_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // Not stored: the tour may show once more.
  }
}

/** Forgets every shown tour ("Replay feature tours"). */
export function resetSeenTours(store: Store | null = defaultStore()): void {
  try {
    store?.removeItem(TOURS_SEEN_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** The steps whose anchor is on screen, in order. A missing anchor skips its step; it never throws. */
export function liveSteps(tour: FeatureTour, has: (selector: string) => boolean): TourStep[] {
  return tour.steps.filter((s) => {
    try {
      return has(s.anchor);
    } catch {
      return false;
    }
  });
}

/** True while the keyboard is in a terminal (xterm.js keeps a hidden textarea inside `.xterm`): a tour waits, so it never takes the focus from typing. */
export function typingInTerminal(active: Element | null): boolean {
  return active !== null && active.closest(".xterm") !== null;
}

/** Whether a tour may start now. */
export function tourMayStart(input: { seen: boolean; running: boolean; typing: boolean }): boolean {
  return !input.seen && !input.running && !input.typing;
}
