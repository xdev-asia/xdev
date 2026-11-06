import { describe, expect, it } from "vitest";
import { cardVisible, DEFAULT_REMIND_DAYS, loadNudge, loadRemindDays, NUDGE_KEY, remindLater, REMIND_DAYS_KEY, saveNudge, saveRemindDays, skipVersion } from "./updateNudge";

const DAY = 24 * 60 * 60 * 1000;
const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};

describe("when the card shows", () => {
  it("shows with nothing put away", () => {
    expect(cardVisible("1.0.0", null, 0)).toBe(true);
  });
  it("a reminder hides the card until its time, exactly", () => {
    const state = remindLater("1.0.0", 1000, 3);
    expect(state.until).toBe(1000 + 3 * DAY);
    expect(cardVisible("1.0.0", state, 1000 + 3 * DAY - 1)).toBe(false);
    expect(cardVisible("1.0.0", state, 1000 + 3 * DAY)).toBe(true);
  });
  it("a skip hides that version for good", () => {
    expect(cardVisible("1.0.0", skipVersion("1.0.0"), Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(cardVisible("0.9.0", skipVersion("1.0.0"), 0)).toBe(false);
  });
  it("a newer version shows at once, a reminder or a skip notwithstanding", () => {
    expect(cardVisible("1.0.1", remindLater("1.0.0", 0, 3), 1)).toBe(true);
    expect(cardVisible("1.10.0", skipVersion("1.9.0"), 0)).toBe(true);
  });
});

describe("what is remembered", () => {
  it("round-trips the state and survives broken data", () => {
    const store = memory();
    expect(loadNudge(store)).toBeNull();
    saveNudge(remindLater("1.0.0", 5, 1), store);
    expect(loadNudge(store)).toEqual({ version: "1.0.0", until: 5 + DAY });
    saveNudge(skipVersion("1.1.0"), store);
    expect(loadNudge(store)).toEqual({ version: "1.1.0", until: null });
    expect(loadNudge(memory({ [NUDGE_KEY]: "{broken" }))).toBeNull();
    expect(loadNudge(memory({ [NUDGE_KEY]: '{"until":3}' }))).toBeNull();
    expect(loadNudge(null)).toBeNull();
  });
  it("keeps the delay, and falls back to 3 days for an odd value", () => {
    const store = memory();
    expect(loadRemindDays(store)).toBe(DEFAULT_REMIND_DAYS);
    saveRemindDays(7, store);
    expect(loadRemindDays(store)).toBe(7);
    expect(loadRemindDays(memory({ [REMIND_DAYS_KEY]: "2" }))).toBe(DEFAULT_REMIND_DAYS);
    expect(loadRemindDays(null)).toBe(DEFAULT_REMIND_DAYS);
  });
});
