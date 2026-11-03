import { expect, it } from "vitest";
import { KEY_SETTINGS_DEFAULTS, type BindingsState } from "@/keys/bindingsStore";
import { mergeBindings } from "@/keys/keybindingsFile";
import type { ActionId } from "@/keys/keymap";
import { PLATFORM } from "@/platform";
import { recorderStep } from "./recorder";
import { addChord, buildRows, clashes, countRows, disableAction, filterRows, removeChord, resetAction, withChords } from "./shortcutsModel";

function state(overrides: [ActionId, string[]][] = []): BindingsState {
  const map = new Map(overrides);
  return { text: null, path: "", overrides: map, bindings: mergeBindings(map, PLATFORM), diagnostics: [], keySettings: KEY_SETTINGS_DEFAULTS };
}
const title = (d: { id: string }) => d.id;
const row = (rows: ReturnType<typeof buildRows>, id: string) => rows.find((r) => r.def.id === id)!;

it("lists every action, marks modified, disabled and unassigned", () => {
  const rows = buildRows(state([["tab.new", ["Ctrl+Alt+N"]], ["tab.close", []]]));
  expect(row(rows, "tab.new")).toMatchObject({ chords: ["Ctrl+Alt+N"], modified: true, disabled: false });
  expect(row(rows, "tab.close")).toMatchObject({ chords: [], modified: true, disabled: true });
  expect(row(rows, "settings.shortcuts")).toMatchObject({ chords: [], modified: false });
  const n = countRows(rows);
  expect(n.modified).toBe(2);
  expect(n.unassigned).toBeGreaterThanOrEqual(2);
  expect(n.all).toBe(rows.length);
});

it("flags two actions on one chord in the same scope", () => {
  const rows = buildRows(state([["tab.new", ["Ctrl+Alt+Q"]], ["tab.close", ["Ctrl+Alt+Q"]]]));
  expect(row(rows, "tab.new").conflict).toBe(true);
  expect(countRows(rows).conflicts).toBeGreaterThanOrEqual(2);
});

it("filters by chip and by search words, ids or chords", () => {
  const rows = buildRows(state([["tab.new", ["Ctrl+Alt+N"]]]));
  expect(filterRows(rows, "", "modified", title).map((r) => r.def.id)).toEqual(["tab.new"]);
  expect(filterRows(rows, "ctrl+alt+n", "all", title).map((r) => r.def.id)).toEqual(["tab.new"]);
  expect(filterRows(rows, "PANEL.EXPL", "all", title).map((r) => r.def.id)).toEqual(["panel.explorer"]);
  expect(filterRows(rows, "", "unassigned", title).every((r) => r.chords.length === 0)).toBe(true);
});

it("a chord list equal to the defaults is no override", () => {
  const rows = buildRows(state());
  const defaults = row(rows, "tab.new").chords;
  expect(withChords(new Map([["tab.new", ["Ctrl+Alt+N"]]]), "tab.new", defaults).has("tab.new")).toBe(false);
});

it("adds, removes, disables and resets a chord", () => {
  let o = new Map<ActionId, string[]>();
  let rows = buildRows(state());
  o = addChord(o, rows, "tab.new", "Ctrl+Alt+N", false);
  expect(o.get("tab.new")).toEqual([...row(rows, "tab.new").chords, "Ctrl+Alt+N"]);
  rows = buildRows(state([...o]));
  o = removeChord(o, rows, "tab.new", "Ctrl+Alt+N");
  expect(o.has("tab.new")).toBe(false);
  expect(disableAction(o, "tab.new").get("tab.new")).toEqual([]);
  expect(resetAction(disableAction(o, "tab.new"), "tab.new").has("tab.new")).toBe(false);
});

it("a taken chord reports who holds it, and Replace takes it from them", () => {
  const rows = buildRows(state());
  const taken = row(rows, "tab.close").chords[0];
  expect(clashes(rows, "tab.new", taken)).toEqual(["tab.close"]);
  const o = addChord(new Map(), rows, "tab.new", taken, true);
  expect(o.get("tab.close")).toEqual([]);
  expect(o.get("tab.new")).toContain(taken);
});

it("the same chord in another scope is no clash", () => {
  const rows = buildRows(state());
  expect(clashes(rows, "docs.search", row(rows, "docs.search").chords[0])).toEqual([]);
});

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  recorderStep({ code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...init });

it("the recorder cancels on Escape, clears on Backspace, ignores modifiers and reads a chord", () => {
  expect(key({ key: "Escape" })).toEqual({ kind: "cancel" });
  expect(key({ key: "Backspace" })).toEqual({ kind: "clear" });
  expect(key({ key: "Control", ctrlKey: true })).toEqual({ kind: "ignore" });
  expect(key({ key: "a", code: "KeyA", ctrlKey: true, shiftKey: true })).toEqual({ kind: "chord", chord: "Ctrl+Shift+A" });
  expect(key({ key: "a", code: "KeyA" })).toEqual({ kind: "invalid" });
});
