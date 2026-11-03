import { afterEach, expect, it } from "vitest";
import { createMockKeybindings, MOCK_KEYBINDINGS_PATH } from "@/mockKeybindings";
import { createMockSettings, createSettingsHub } from "@/mockSettings";
import {
  getBindingsState,
  KEY_SETTINGS_DEFAULTS,
  loadBindings,
  resetBindingsForTests,
  setKeybindingsText,
  startBindingsSync,
  subscribeBindings,
} from "./bindingsStore";
import { DEFAULT_BINDINGS, effectiveBindings, type ActionId } from "./keymap";

afterEach(() => resetBindingsForTests());

const chordsOf = (action: ActionId) => effectiveBindings().filter((b) => b.action === action).map((b) => b.chord);
const file = (keybindings: Record<string, unknown>) => JSON.stringify({ version: 1, keybindings });
const flush = () => new Promise((r) => setTimeout(r, 0));

function api(initial: string | null = null) {
  return { ...createMockKeybindings(initial), ...createMockSettings(createSettingsHub()) };
}

it("holds the registry's defaults before anything loads", () => {
  expect(effectiveBindings().map(({ action, chord }) => ({ action, chord }))).toEqual(DEFAULT_BINDINGS);
  expect(effectiveBindings().every((b) => b.source === "default")).toBe(true);
  expect(getBindingsState().keySettings).toEqual(KEY_SETTINGS_DEFAULTS);
  expect(getBindingsState().diagnostics).toEqual([]);
});

it("a loaded file puts its chords over the defaults and keeps its diagnostics", async () => {
  await loadBindings(api(file({ "tab.new": ["Ctrl+Alt+N"], "tab.close": [], "no.such": ["Ctrl+Q"] })));
  const state = getBindingsState();
  expect(state.path).toBe(MOCK_KEYBINDINGS_PATH);
  expect(chordsOf("tab.new")).toEqual(["Ctrl+Alt+N"]);
  expect(effectiveBindings().find((b) => b.action === "tab.new")?.source).toBe("user");
  expect(chordsOf("tab.close")).toEqual([]);
  expect(state.diagnostics.map((d) => d.kind)).toEqual(["unknownAction"]);
});

it("a broken file keeps every default and says why", async () => {
  await loadBindings(api("{ not json"));
  expect(chordsOf("tab.new")).toEqual(["Ctrl+T"]);
  expect(getBindingsState().diagnostics.map((d) => d.kind)).toEqual(["parse"]);
});

it("a failed read keeps what was there", async () => {
  setKeybindingsText(file({ "tab.new": ["Ctrl+Alt+N"] }));
  await loadBindings({ keybindingsRead: () => Promise.reject({ code: "io" }) });
  expect(chordsOf("tab.new")).toEqual(["Ctrl+Alt+N"]);
});

it("a read that started before a change does not put the older text back", async () => {
  let answer!: (v: { text: string | null; path: string }) => void;
  const pending = loadBindings({ keybindingsRead: () => new Promise((r) => (answer = r)) });
  setKeybindingsText(file({ "tab.new": ["Ctrl+Alt+N"] }));
  answer({ text: null, path: MOCK_KEYBINDINGS_PATH });
  await pending;
  expect(chordsOf("tab.new")).toEqual(["Ctrl+Alt+N"]);
});

it("a change to the file reloads the bindings and tells subscribers", async () => {
  const desktop = api(null);
  const stop = startBindingsSync(desktop);
  await flush();
  let calls = 0;
  const unsubscribe = subscribeBindings(() => (calls += 1));
  desktop.__editKeybindings(file({ "palette.jump": ["Ctrl+Shift+J"] }));
  expect(chordsOf("palette.jump")).toEqual(["Ctrl+Shift+J"]);
  expect(calls).toBe(1);
  // The same text again changes nothing.
  desktop.__editKeybindings(file({ "palette.jump": ["Ctrl+Shift+J"] }));
  expect(calls).toBe(1);
  desktop.__editKeybindings(null);
  expect(chordsOf("palette.jump")).toEqual(["Ctrl+J"]);
  unsubscribe();
  stop();
  desktop.__editKeybindings(file({ "palette.jump": [] }));
  expect(chordsOf("palette.jump")).toEqual(["Ctrl+J"]);
});

it("follows the key settings when settings://changed names keys", async () => {
  const desktop = api();
  const stop = startBindingsSync(desktop);
  await flush();
  await desktop.keySettingsPut({ terminalPolicy: "terminal-first", terminalHints: false });
  await flush();
  expect(getBindingsState().keySettings).toEqual({ terminalPolicy: "terminal-first", terminalHints: false });
  stop();
});
