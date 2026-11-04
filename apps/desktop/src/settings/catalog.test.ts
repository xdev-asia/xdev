import { describe, expect, it } from "vitest";
import { QUERY_MAX, searchSettings, type SettingEntry } from "./catalog";

const dict: Record<string, string> = {
  "t.a": "Font size",
  "t.b": "Cursor",
  "d.b": "Shape of the caret",
  "t.c": "Scrollback",
  "t.vi": "Phông chữ",
};
const t = (k: string) => dict[k] ?? k;
const sec = (s: string) => (s === "terminal" ? "Terminal" : "Editor");
const E = (id: string, section: string, titleKey: string, keywords: string[] = [], descriptionKey?: string): SettingEntry => ({
  id, section, titleKey, keywords, descriptionKey,
});
const entries = [
  E("terminal.fontSize", "terminal", "t.a", ["zoom"]),
  E("terminal.cursor", "terminal", "t.b", ["caret"], "d.b"),
  E("editor.scrollback", "editor", "t.c", ["history"]),
  E("editor.vi", "editor", "t.vi", ["phong chu"]),
];
const score = (q: string, id: string) => searchSettings(q, entries, t, sec).find((h) => h.entry.id === id)?.score;

describe("searchSettings", () => {
  it("empty or blank query returns every entry with score 0 in catalog order", () => {
    for (const q of ["", "   "]) {
      const hits = searchSettings(q, entries, t, sec);
      expect(hits.map((h) => h.entry.id)).toEqual(entries.map((e) => e.id));
      expect(hits.every((h) => h.score === 0)).toBe(true);
    }
  });
  it("section title scores 900 / 850 / 800 and beats the entry title", () => {
    expect(score("terminal", "terminal.fontSize")).toBe(900);
    expect(score("termin", "terminal.fontSize")).toBe(850);
    expect(score("ermina", "terminal.fontSize")).toBe(800);
  });
  it("entry title scores 700 / 650 / 600", () => {
    expect(score("font size", "terminal.fontSize")).toBe(700);
    expect(score("font", "terminal.fontSize")).toBe(650);
    expect(score("size", "terminal.fontSize")).toBe(600);
  });
  it("description scores 500 / 450 / 400", () => {
    expect(score("shape of the caret", "terminal.cursor")).toBe(500);
    expect(score("shape", "terminal.cursor")).toBe(450);
    expect(score("caret", "terminal.cursor")).toBe(400); // contains in the description beats an exact keyword
  });
  it("keyword-only match scores 300 / 250 / 200", () => {
    expect(score("history", "editor.scrollback")).toBe(300);
    expect(score("hist", "editor.scrollback")).toBe(250);
    expect(score("stor", "editor.scrollback")).toBe(200);
  });
  it("drops zero scores and sorts by score then catalog order", () => {
    const hits = searchSettings("s", entries, t, sec);
    expect(hits.every((h) => h.score > 0)).toBe(true);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    expect(searchSettings("nomatchatall", entries, t, sec)).toEqual([]);
  });
  it("ignores case and surrounding spaces", () => {
    expect(score("  FONT Size ", "terminal.fontSize")).toBe(700);
  });
  it("cuts a 3 KiB query to QUERY_MAX without throwing", () => {
    expect(() => searchSettings("é".repeat(3000), entries, t, sec)).not.toThrow();
    expect(searchSettings("a".repeat(3 * 1024), entries, t, sec)).toEqual([]);
    expect(QUERY_MAX).toBe(2048);
  });
  it("compares Vietnamese diacritics as typed", () => {
    expect(score("phông", "editor.vi")).toBe(650);
    expect(score("phong", "editor.vi")).toBe(250); // only the keyword; the title is not folded
    expect(score("phong chu", "editor.vi")).toBe(300);
  });
});

it("a mac-only entry is listed for mac and for no other platform", async () => {
  const { settingEntriesFor, SETTING_ENTRIES } = await import("./catalog");
  const id = "terminal.optionAsAlt";
  expect(settingEntriesFor("mac").some((x) => x.id === id)).toBe(true);
  expect(settingEntriesFor("win").some((x) => x.id === id)).toBe(false);
  expect(settingEntriesFor("linux").some((x) => x.id === id)).toBe(false);
  expect(settingEntriesFor("win").length).toBe(SETTING_ENTRIES.length - 1);
});
