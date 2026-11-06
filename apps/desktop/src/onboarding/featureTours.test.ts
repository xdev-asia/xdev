import { describe, expect, it } from "vitest";
import { translate } from "@/i18n";
import { runHelpPick } from "@/workspace/HelpMenu";
import { FEATURE_TOURS, liveSteps, loadSeenTours, markTourSeen, resetSeenTours, tourMayStart, typingInTerminal } from "./featureTours";

const memory = (initial?: string) => {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => void (value = v),
    removeItem: () => void (value = null),
  };
};

describe("feature tour model", () => {
  it("each tour has two to four steps", () => {
    for (const tour of Object.values(FEATURE_TOURS)) expect(tour.steps.length).toBeGreaterThanOrEqual(2), expect(tour.steps.length).toBeLessThanOrEqual(4);
  });
  it("a missing anchor skips its step, and a throwing lookup never throws", () => {
    const tour = FEATURE_TOURS.worktree;
    const live = liveSteps(tour, (s) => s !== tour.steps[1]!.anchor);
    expect(live.map((s) => s.id)).toEqual(["name", "agent"]);
    expect(liveSteps(tour, () => { throw new Error("bad selector"); })).toEqual([]);
  });
  it("remembers a shown tour, forgets on reset, and reads a damaged value as nothing seen", () => {
    const store = memory();
    markTourSeen("review", store);
    markTourSeen("worktree", store);
    expect([...loadSeenTours(store)]).toEqual(["review", "worktree"]);
    resetSeenTours(store);
    expect(loadSeenTours(store).size).toBe(0);
    expect(loadSeenTours(memory("{not json")).size).toBe(0);
    expect(loadSeenTours(null).size).toBe(0);
  });
  it("waits while the keyboard is in a terminal", () => {
    expect(tourMayStart({ seen: false, running: false, typing: true })).toBe(false);
    expect(tourMayStart({ seen: true, running: false, typing: false })).toBe(false);
    expect(tourMayStart({ seen: false, running: false, typing: false })).toBe(true);
    const inTerm = { closest: (sel: string) => (sel === ".xterm" ? {} : null) } as unknown as Element;
    const elsewhere = { closest: () => null } as unknown as Element;
    expect(typingInTerminal(inTerm)).toBe(true);
    expect(typingInTerminal(elsewhere)).toBe(false);
    expect(typingInTerminal(null)).toBe(false);
  });
});

describe("tour texts and the Help entry", () => {
  it("every step has an English and a Vietnamese text", () => {
    for (const tour of Object.values(FEATURE_TOURS))
      for (const step of tour.steps)
        for (const key of [step.titleKey, step.bodyKey]) {
          expect(translate("en", key)).not.toBe(key);
          expect(translate("vi", key)).not.toBe(key);
        }
  });
  it("Replay feature tours forgets the shown tours and says so", () => {
    const calls: string[] = [];
    const h = { openSettings() {}, openUpdates() {}, openAbout() {}, toast: (k: string) => calls.push(k), api: {} as never };
    runHelpPick("replay-feature-tours", h);
    expect(calls).toEqual(["tour.featuresReset"]);
  });
});
