import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { loadSeen, markSeen, shouldStart, stepToShow, TOUR_STEPS, type TourGate } from "./tourModel";
import { replayCount, replayTour, subscribeReplay } from "./tourStore";
import { runHelpPick, HELP_ITEMS } from "@/workspace/HelpMenu";

const ready: TourGate = { seen: false, replay: false, onboarding: false, terminal: true, running: false };
const has = (...found: string[]) => (selector: string) => found.includes(selector);

describe("when the tour starts", () => {
  it("shows on the first terminal after onboarding", () => {
    expect(shouldStart(ready)).toBe(true);
  });
  it("shows once: not again when seen", () => {
    expect(shouldStart({ ...ready, seen: true })).toBe(false);
  });
  it("waits for the stored flag", () => {
    expect(shouldStart({ ...ready, seen: null })).toBe(false);
  });
  it("does not show during onboarding, even on a replay", () => {
    expect(shouldStart({ ...ready, onboarding: true })).toBe(false);
    expect(shouldStart({ ...ready, onboarding: true, seen: true, replay: true })).toBe(false);
  });
  it("does not show without a visible terminal", () => {
    expect(shouldStart({ ...ready, terminal: false })).toBe(false);
  });
  it("a replay shows although the tour was seen, and a running tour is not restarted", () => {
    expect(shouldStart({ ...ready, seen: true, replay: true })).toBe(true);
    expect(shouldStart({ ...ready, seen: true, replay: true, running: true })).toBe(false);
  });
});

describe("steps", () => {
  it("point at the split control, then the agent menu", () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(["split", "agent"]);
    expect(translate("en", TOUR_STEPS[0].titleKey)).toBe("Split a terminal pane");
    expect(translate("en", TOUR_STEPS[1].titleKey)).toBe("Start an agent here");
  });
  it("end when the anchor is gone (no anchor, no card)", () => {
    expect(stepToShow(0, has())).toBeNull();
    expect(stepToShow(0, has(TOUR_STEPS[0].anchor))?.id).toBe("split");
    expect(stepToShow(1, has(TOUR_STEPS[0].anchor))).toBeNull();
    expect(stepToShow(2, has(TOUR_STEPS[0].anchor, TOUR_STEPS[1].anchor))).toBeNull();
  });
  it("have a title and body in en and vi", () => {
    for (const step of TOUR_STEPS) for (const key of [step.titleKey, step.bodyKey]) for (const l of ["en", "vi"] as const) expect(translate(l, key)).not.toBe(key);
  });
});

describe("tour.seen", () => {
  it("starts false, and Done or Skip keep it", async () => {
    const api = createMockApi({});
    expect(await loadSeen(api)).toBe(false);
    await markSeen(api);
    expect(await loadSeen(api)).toBe(true);
    expect((await api.uiSettingsGet()).tourSeen).toBe(true);
  });
  it("keeps the other view settings when it stores the flag", async () => {
    const api = createMockApi({});
    await api.uiSettingsPut({ ...(await api.uiSettingsGet()), zoom: 1.25 });
    await markSeen(api);
    expect((await api.uiSettingsGet()).zoom).toBe(1.25);
  });
  it("is not written twice", async () => {
    const api = createMockApi({});
    const put = vi.spyOn(api, "uiSettingsPut");
    await markSeen(api);
    await markSeen(api);
    expect(put).toHaveBeenCalledTimes(1);
  });
  it("reads as not seen when the settings fail, so a first run still shows", async () => {
    const api = { uiSettingsGet: () => Promise.reject(new Error("x")), uiSettingsPut: vi.fn() };
    expect(await loadSeen(api as never)).toBe(false);
    await markSeen(api as never);
    expect(api.uiSettingsPut).not.toHaveBeenCalled();
  });
});

describe("replay", () => {
  it("is in the Help menu and the palette", () => {
    expect(HELP_ITEMS.some((i) => i.id === "replay-tour")).toBe(true);
    for (const l of ["en", "vi"] as const) {
      expect(translate(l, "shell.help.replayTour")).not.toBe("shell.help.replayTour");
      expect(translate(l, "palette.action.replayTour")).not.toBe("palette.action.replayTour");
    }
  });
  it("picking it from Help, or asking from the palette, tells the tour once each", () => {
    const heard = vi.fn();
    const off = subscribeReplay(heard);
    const before = replayCount();
    const h = { openSettings: vi.fn(), openUpdates: vi.fn(), openAbout: vi.fn(), api: createMockApi({}) };
    runHelpPick("replay-tour", h);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(replayCount()).toBe(before + 1);
    expect(h.openSettings).not.toHaveBeenCalled();
    replayTour();
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    replayTour();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
