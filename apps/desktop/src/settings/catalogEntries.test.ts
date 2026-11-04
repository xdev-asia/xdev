import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import vi from "@/i18n/vi.json";
import { SETTING_ENTRIES } from "./catalog";
import { SECTIONS } from "./sections";

describe("SETTING_ENTRIES", () => {
  it("has unique, well formed ids", () => {
    const ids = SETTING_ENTRIES.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9.]+$/);
  });
  it("points every entry at a real section, and every section has entries", () => {
    const sections = new Set(SECTIONS.map((s) => s.id));
    for (const x of SETTING_ENTRIES) expect(sections.has(x.section), x.id).toBe(true);
    for (const s of SECTIONS) expect(SETTING_ENTRIES.some((x) => x.section === s.id), s.id).toBe(true);
  });
  it("uses i18n keys that exist in both languages", () => {
    for (const x of SETTING_ENTRIES) {
      for (const key of [x.titleKey, x.descriptionKey].filter((k): k is string => !!k)) {
        expect(key in en, `en ${key}`).toBe(true);
        expect(key in vi, `vi ${key}`).toBe(true);
      }
    }
  });
  it("keeps keywords lower case", () => {
    for (const x of SETTING_ENTRIES) for (const k of x.keywords) expect(k, x.id).toBe(k.toLowerCase());
  });
});
