import { expect, it } from "vitest";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { CARD_PARTS, cardParts } from "./cardModel";

const prefs = SIDEBAR_PREFS_DEFAULTS;

it("a detailed card with every property on shows all nine parts", () => {
  expect([...cardParts(prefs)].sort()).toEqual([...CARD_PARTS].sort());
  expect(CARD_PARTS).toHaveLength(9);
});

it("each property that is off drops its part", () => {
  for (const part of CARD_PARTS) {
    const parts = cardParts({ ...prefs, card: { ...prefs.card, [part]: false } });
    expect(parts.has(part), part).toBe(false);
    expect(parts.size, part).toBe(8);
  }
});

it("a compact card keeps only time, line counts and the pull request", () => {
  expect([...cardParts({ ...prefs, compactCards: true })].sort()).toEqual(["diffStat", "pr", "time"]);
  const parts = cardParts({ ...prefs, compactCards: true, card: { ...prefs.card, time: false, pr: false } });
  expect([...parts]).toEqual(["diffStat"]);
});
