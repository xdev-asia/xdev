import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetBindingsForTests, setKeybindingsText, setKeySettings } from "./bindingsStore";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { resetTerminalKeyForTests, setTerminalKeyHost } from "./terminalKey";
import { actionOf, actionsOf, appOwnsKey, chordLabel, chordOf, DEFAULT_BINDINGS, eventChord, suspendKeymap, TERMINAL_KEEPS, useKeymap, type ActionId } from "./keymap";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => void hooks.effects.push(effect),
}));

beforeEach(() => { hooks.effects = []; });
afterEach(() => {
  vi.unstubAllGlobals();
  resetBindingsForTests();
  suspendKeymap(false);
  resetToastsForTests();
  resetTerminalKeyForTests();
});

const ev = (init: Record<string, unknown>) =>
  ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, code: "", ...init }) as unknown as KeyboardEvent;

// What a key press looks like for each default chord, off macOS.
const PRESS: Record<string, Record<string, unknown>> = {
  "Ctrl+T": { ctrlKey: true, code: "KeyT" },
  "Ctrl+W": { ctrlKey: true, code: "KeyW" },
  "Ctrl+Tab": { ctrlKey: true, code: "Tab" },
  "Ctrl+Shift+Tab": { ctrlKey: true, shiftKey: true, code: "Tab" },
  "Ctrl+Shift+D": { ctrlKey: true, shiftKey: true, code: "KeyD" },
  "Alt+Shift+D": { altKey: true, shiftKey: true, code: "KeyD" },
  "Ctrl+]": { ctrlKey: true, code: "BracketRight" },
  "Ctrl+[": { ctrlKey: true, code: "BracketLeft" },
  "Ctrl+Shift+Enter": { ctrlKey: true, shiftKey: true, code: "Enter" },
  "Ctrl+Shift+=": { ctrlKey: true, shiftKey: true, code: "Equal" },
  "Ctrl+Shift+Up": { ctrlKey: true, shiftKey: true, code: "ArrowUp" },
  "Ctrl+Shift+Down": { ctrlKey: true, shiftKey: true, code: "ArrowDown" },
  "Ctrl+Alt+T": { ctrlKey: true, altKey: true, code: "KeyT" },
  "Ctrl+J": { ctrlKey: true, code: "KeyJ" },
};
// The other default chords: a press built from the chord.
const CODES: Record<string, string> = {
  "=": "Equal", "-": "Minus", ",": "Comma", "[": "BracketLeft", "]": "BracketRight", Up: "ArrowUp", Down: "ArrowDown",
};
function pressOf(chord: string): Record<string, unknown> {
  if (PRESS[chord]) return PRESS[chord];
  const parts = chord.split("+");
  const key = parts.pop()!;
  const code = CODES[key] ?? (/^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : key);
  return { ctrlKey: parts.includes("Ctrl"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift"), code };
}
for (let n = 1; n <= 9; n++) {
  PRESS[`Alt+${n}`] = { altKey: true, code: `Digit${n}` };
  PRESS[`Ctrl+${n}`] = { ctrlKey: true, code: `Digit${n}` };
}

it("every default binding is reached by its chord off macOS", () => {
  for (const b of DEFAULT_BINDINGS) {
    const press = PRESS[b.chord];
    if (press) expect(actionOf(ev(press), false), b.chord).toBe(b.action);
    expect(actionsOf(ev(pressOf(b.chord)), false), b.chord).toContain(b.action);
  }
});

it("a chord shared across scopes lists the global action first", () => {
  expect(actionsOf(ev({ ctrlKey: true, code: "KeyK" }), false)).toEqual(["search.open", "terminal.clear", "docs.search"]);
  expect(actionOf(ev({ ctrlKey: true, code: "KeyK" }), false)).toBe("search.open");
});

it("eventChord writes what normalizeChord writes", () => {
  expect(eventChord(ev({ ctrlKey: true, shiftKey: true, code: "Equal" }), "win")).toBe("Ctrl+Shift+=");
  expect(eventChord(ev({ metaKey: true, altKey: true, ctrlKey: true, shiftKey: true, code: "KeyD" }), "mac")).toBe("Ctrl+Alt+Shift+Cmd+D");
  expect(eventChord(ev({ shiftKey: true, code: "Insert" }), "win")).toBe("Shift+Insert");
  expect(eventChord(ev({ ctrlKey: true, code: "NumpadAdd" }), "linux")).toBe("Ctrl+NumpadAdd");
  expect(eventChord(ev({ code: "F5" }), "win")).toBe("F5");
  expect(eventChord(ev({ shiftKey: true, code: "KeyA" }), "win")).toBeNull();
  expect(eventChord(ev({ metaKey: true, code: "KeyA" }), "win")).toBeNull();
});

it("macOS copy and paste in a terminal are Cmd+C and Cmd+V", () => {
  expect(actionsOf(ev({ metaKey: true, code: "KeyC" }), true)).toEqual(["terminal.copy"]);
  expect(actionsOf(ev({ ctrlKey: true, shiftKey: true, code: "KeyC" }), false)).toEqual(["terminal.copy"]);
});

it("on macOS Ctrl is Cmd, but Ctrl+Tab and Ctrl+Alt+T keep Ctrl", () => {
  expect(actionOf(ev({ metaKey: true, code: "KeyJ" }), true)).toBe("palette.jump");
  expect(actionOf(ev({ ctrlKey: true, code: "KeyJ" }), true)).toBeNull();
  expect(actionOf(ev({ metaKey: true, code: "KeyT" }), true)).toBe("tab.new");
  expect(actionOf(ev({ ctrlKey: true, code: "KeyT" }), true)).toBeNull();
  expect(actionOf(ev({ ctrlKey: true, code: "Tab" }), true)).toBe("tab.next");
  expect(actionOf(ev({ ctrlKey: true, altKey: true, code: "KeyT" }), true)).toBe("agent.new");
  expect(actionOf(ev({ metaKey: true, code: "Digit3" }), true)).toBe("worktree.select.3");
  expect(chordOf(ev({ metaKey: true, shiftKey: true, code: "KeyD" }), true)).toBe("Mod+Shift+D");
});

it("Meta is not a chord off macOS", () => {
  expect(chordOf(ev({ metaKey: true, code: "KeyJ" }), false)).toBeNull();
});

it("a key without a modifier, or a lone modifier, is not a chord", () => {
  expect(chordOf(ev({ code: "KeyT" }), false)).toBeNull();
  expect(chordOf(ev({ ctrlKey: true, code: "ControlLeft" }), false)).toBeNull();
});

it("the physical key decides, not the layout", () => {
  expect(actionOf(ev({ ctrlKey: true, code: "KeyT", key: "е" }), false)).toBe("tab.new");
});

it("labels read Ctrl+T off macOS and ⌘J on macOS", () => {
  expect(chordLabel("tab.new", false)).toBe("Ctrl+T");
  expect(chordLabel("pane.splitRight", false)).toBe("Ctrl+Shift+D");
  expect(chordLabel("palette.jump", true)).toBe("⌘J");
  expect(chordLabel("tab.new", true)).toBe("⌘T");
  expect(chordLabel("tab.next", true)).toBe("⌃Tab");
});

function setup(handlers: Partial<Record<ActionId, () => boolean | void>>, opts?: { when?: () => boolean }, modal = false, docsHidden = false) {
  const listeners: { type: string; fn: (e: Event) => void; capture: unknown }[] = [];
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: Event) => void, capture?: unknown) => listeners.push({ type, fn, capture }),
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector === ".ws-docs" ? (docsHidden ? { hasAttribute: () => true } : null) : modal ? {} : null,
  });
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  useKeymap(handlers, opts);
  const stop = hooks.effects.at(-1)!()!;
  // `inTerminal`: the key comes from inside an `.xterm`, as a focused terminal sends it.
  const press = (init: Record<string, unknown>, inTerminal = false) => {
    const { defaultPrevented, ...rest } = init;
    const event = Object.assign(new Event("keydown", { cancelable: true }), ev(rest));
    if (defaultPrevented) event.preventDefault();
    if (inTerminal) Object.defineProperty(event, "target", { value: { closest: (s: string) => (s === ".xterm" ? {} : null) } });
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    listeners.forEach((l) => l.fn(event));
    return { event, stopPropagation };
  };
  return { press, stop, listeners };
}

it("takes the key in the capture phase and stops it", () => {
  const run = vi.fn();
  const { press, listeners } = setup({ "tab.new": run });
  expect(listeners[0].capture).toBe(true);
  const { event, stopPropagation } = press(PRESS["Ctrl+T"]);
  expect(run).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(true);
  expect(stopPropagation).toHaveBeenCalled();
});

it("a handler returning false lets the key go on", () => {
  const run = vi.fn(() => false);
  const { press } = setup({ "tab.close": run });
  const { event, stopPropagation } = press(PRESS["Ctrl+W"]);
  expect(run).toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
  expect(stopPropagation).not.toHaveBeenCalled();
});

it("a chord with no handler is left alone", () => {
  const { press } = setup({ "tab.new": vi.fn() });
  expect(press(PRESS["Ctrl+W"]).event.defaultPrevented).toBe(false);
});

it("an IME that is composing is ignored", () => {
  const run = vi.fn();
  const { press } = setup({ "tab.new": run });
  press({ ...PRESS["Ctrl+T"], isComposing: true });
  press({ ...PRESS["Ctrl+T"], keyCode: 229 });
  expect(run).not.toHaveBeenCalled();
});

it("a modal dialog blocks every chord but the palette key", () => {
  const run = vi.fn();
  const jump = vi.fn();
  const { press } = setup({ "tab.new": run, "palette.jump": jump }, undefined, true);
  press(PRESS["Ctrl+T"]);
  press(PRESS["Ctrl+J"]);
  expect(run).not.toHaveBeenCalled();
  expect(jump).toHaveBeenCalledTimes(1);
});

it("the keymap does not look at the target, so a text field does not stop a pane chord", () => {
  const run = vi.fn();
  const { press } = setup({ "pane.splitRight": run });
  press(PRESS["Ctrl+Shift+D"]);
  expect(run).toHaveBeenCalledTimes(1);
});

it("a plain key never reaches a handler", () => {
  const run = vi.fn();
  const { press } = setup({ "tab.new": run, "pane.splitRight": run });
  const { event } = press({ code: "KeyD" });
  expect(run).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

it("`when` false skips the chord", () => {
  const run = vi.fn();
  const { press } = setup({ "tab.new": run }, { when: () => false });
  const { event } = press(PRESS["Ctrl+T"]);
  expect(run).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

it("a held chord is swallowed and fires once", () => {
  const run = vi.fn();
  const { press } = setup({ "tab.close": run });
  press(PRESS["Ctrl+W"]);
  const { event } = press({ ...PRESS["Ctrl+W"], repeat: true });
  expect(run).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(true);
});

it("the cleanup removes the listener", () => {
  const { stop, listeners } = setup({ "tab.new": vi.fn() });
  stop();
  expect(listeners).toHaveLength(0);
});

const file = (keybindings: Record<string, unknown>) => JSON.stringify({ version: 1, keybindings });

it("an override changes the chord the keymap reacts to", () => {
  setKeybindingsText(file({ "tab.new": ["Ctrl+Alt+N"] }));
  const run = vi.fn();
  const { press } = setup({ "tab.new": run });
  press(PRESS["Ctrl+T"]);
  expect(run).not.toHaveBeenCalled();
  press({ ctrlKey: true, altKey: true, code: "KeyN" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(chordLabel("tab.new", false)).toBe("Ctrl+Alt+N");
});

it("a disabled action no longer fires and has no label", () => {
  setKeybindingsText(file({ "tab.close": [] }));
  const run = vi.fn();
  const { press } = setup({ "tab.close": run });
  expect(press(PRESS["Ctrl+W"]).event.defaultPrevented).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(chordLabel("tab.close", false)).toBeNull();
});

it("a file change after the listener started applies to the next key", () => {
  const run = vi.fn();
  const { press } = setup({ "palette.jump": run });
  press(PRESS["Ctrl+J"]);
  setKeybindingsText(file({ "palette.jump": ["Ctrl+Shift+J"] }));
  press(PRESS["Ctrl+J"]);
  press({ ctrlKey: true, shiftKey: true, code: "KeyJ" });
  expect(run).toHaveBeenCalledTimes(2);
});

it("while suspended nothing fires", () => {
  const run = vi.fn();
  const { press } = setup({ "tab.new": run });
  suspendKeymap(true);
  expect(press(PRESS["Ctrl+T"]).event.defaultPrevented).toBe(false);
  suspendKeymap(false);
  press(PRESS["Ctrl+T"]);
  expect(run).toHaveBeenCalledTimes(1);
});

it("a key an earlier listener took is left alone", () => {
  const run = vi.fn();
  const { press } = setup({ "tab.new": run });
  press({ ...PRESS["Ctrl+T"], defaultPrevented: true });
  expect(run).not.toHaveBeenCalled();
});

it("a terminal-scope action runs only from a terminal, and there it shadows the global one", () => {
  const search = vi.fn();
  const clear = vi.fn();
  const { press } = setup({ "search.open": search, "terminal.clear": clear }, undefined, false, true);
  press({ ctrlKey: true, code: "KeyK" });
  expect([search.mock.calls.length, clear.mock.calls.length]).toEqual([1, 0]);
  press({ ctrlKey: true, code: "KeyK" }, true);
  expect([search.mock.calls.length, clear.mock.calls.length]).toEqual([1, 1]);
});

it("a shadowed global action does not run from another view's listener", () => {
  const search = vi.fn();
  // This view has no terminal.clear handler, but the terminal-scope action wins the chord.
  const { press } = setup({ "search.open": search });
  const { event } = press({ ctrlKey: true, code: "KeyK" }, true);
  expect(search).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

it("a docs-scope action shadows the global one only while the docs view is shown", () => {
  const search = vi.fn();
  const docs = vi.fn();
  setup({ "search.open": search, "docs.search": docs }, undefined, false, true).press({ ctrlKey: true, code: "KeyK" });
  expect([search.mock.calls.length, docs.mock.calls.length]).toEqual([1, 0]);
  setup({ "search.open": search, "docs.search": docs }).press({ ctrlKey: true, code: "KeyK" });
  expect([search.mock.calls.length, docs.mock.calls.length]).toEqual([1, 1]);
});

it("appOwnsKey under app first: every global or terminal action on the chord", () => {
  setKeySettings({ terminalPolicy: "app-first", terminalHints: true });
  expect(appOwnsKey(ev(PRESS["Ctrl+T"]), false)).toBe("tab.new");
  expect(appOwnsKey(ev(PRESS["Ctrl+]"]), false)).toBe("pane.next");
  expect(appOwnsKey(ev({ ctrlKey: true, code: "KeyK" }), false)).toBe("terminal.clear");
  expect(appOwnsKey(ev({ ctrlKey: true, code: "KeyF" }), false)).toBe("terminal.find");
  expect(appOwnsKey(ev({ ctrlKey: true, code: "KeyS" }), false)).toBeNull();
  expect(appOwnsKey(ev({ code: "KeyA" }), false)).toBeNull();
  expect(appOwnsKey(ev({ shiftKey: true, code: "KeyA" }), false)).toBeNull();
});

it("appOwnsKey under terminal first leaves the keys a TUI uses to the program", () => {
  setKeySettings({ terminalPolicy: "terminal-first", terminalHints: true });
  expect(appOwnsKey(ev(PRESS["Ctrl+T"]), false)).toBe("tab.new");
  expect(appOwnsKey(ev({ ctrlKey: true, shiftKey: true, code: "KeyC" }), false)).toBe("terminal.copy");
  expect(appOwnsKey(ev(PRESS["Ctrl+]"]), false)).toBeNull();
  expect(appOwnsKey(ev(PRESS["Ctrl+Shift+D"]), false)).toBeNull();
  // Ctrl+K: terminal.clear yields, so the global search is what is left on the chord.
  expect(appOwnsKey(ev({ ctrlKey: true, code: "KeyK" }), false)).toBe("search.open");
  expect(appOwnsKey(ev({ ctrlKey: true, code: "KeyF" }), false)).toBeNull();
});

it("the keys a terminal always keeps are the R5 list, and a binding on one works only outside", () => {
  expect([...TERMINAL_KEEPS].sort()).toEqual(["Ctrl+A", "Ctrl+C", "Ctrl+D", "Ctrl+E", "Ctrl+N", "Ctrl+P", "Ctrl+R", "Ctrl+U", "Ctrl+Z"]);
  setKeybindingsText(file({ "palette.jump": ["Ctrl+D"] }));
  expect(appOwnsKey(ev({ ctrlKey: true, code: "KeyD" }), false)).toBeNull();
  const run = vi.fn();
  const { press } = setup({ "palette.jump": run });
  expect(press({ ctrlKey: true, code: "KeyD" }, true).event.defaultPrevented).toBe(false);
  press({ ctrlKey: true, code: "KeyD" });
  expect(run).toHaveBeenCalledTimes(1);
});

// ---- The X-1 toast ----

const GIT = { ctrlKey: true, shiftKey: true, code: "KeyG" };
function toastHost() {
  const open = vi.fn();
  setTerminalKeyHost({ t: (k, v) => (v ? `${k} ${JSON.stringify(v)}` : k), openShortcuts: open });
  return open;
}

it("an app key taken from a focused terminal shows the toast once", () => {
  const open = toastHost();
  const run = vi.fn();
  const { press } = setup({ "panel.sourceControl": run });
  press(GIT, true);
  expect(run).toHaveBeenCalledTimes(1);
  expect(getToasts()).toHaveLength(1);
  expect(getToasts()[0].text).toContain('"title":"keys.action.panel.sourceControl"');
  expect(getToasts()[0].text).toContain('"chord":"Ctrl+Shift+G"');
  press(GIT, true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(getToasts()).toHaveLength(1);
  getToasts()[0].actions[0].run();
  expect(open).toHaveBeenCalledWith("panel.sourceControl");
});

it("no toast outside a terminal, with hints off, or when the key goes to the program", () => {
  toastHost();
  const run = vi.fn();
  const { press } = setup({ "panel.sourceControl": run, "terminal.find": vi.fn() });
  press(GIT, false);
  expect(getToasts()).toHaveLength(0);
  setKeySettings({ terminalPolicy: "app-first", terminalHints: false });
  press(GIT, true);
  expect(getToasts()).toHaveLength(0);
  setKeySettings({ terminalPolicy: "terminal-first", terminalHints: true });
  // Ctrl+F is the terminal's own under terminal first: nothing runs, nothing shows.
  press({ ctrlKey: true, code: "KeyF" }, true);
  expect(getToasts()).toHaveLength(0);
});

it("a key the terminal always keeps (Ctrl+N) is not an app key there", () => {
  toastHost();
  const { press } = setup({ "docs.new": vi.fn() });
  press({ ctrlKey: true, code: "KeyN" }, true);
  expect(getToasts()).toHaveLength(0);
});
