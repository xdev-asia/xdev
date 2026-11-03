import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { actionOf, chordLabel, chordOf, DEFAULT_BINDINGS, useKeymap, type ActionId } from "./keymap";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => void hooks.effects.push(effect),
}));

beforeEach(() => { hooks.effects = []; });
afterEach(() => { vi.unstubAllGlobals(); });

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
  "Mod+J": { ctrlKey: true, code: "KeyJ" },
};
for (let n = 1; n <= 9; n++) {
  PRESS[`Alt+${n}`] = { altKey: true, code: `Digit${n}` };
  PRESS[`Ctrl+${n}`] = { ctrlKey: true, code: `Digit${n}` };
}

it("every default binding is reached by its chord off macOS", () => {
  for (const b of DEFAULT_BINDINGS) {
    const press = PRESS[b.chord];
    expect(press, b.chord).toBeDefined();
    expect(actionOf(ev(press), false), b.chord).toBe(b.action);
  }
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

function setup(handlers: Partial<Record<ActionId, () => boolean | void>>, opts?: { when?: () => boolean }, modal = false) {
  const listeners: { type: string; fn: (e: Event) => void; capture: unknown }[] = [];
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: Event) => void, capture?: unknown) => listeners.push({ type, fn, capture }),
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  vi.stubGlobal("document", { querySelector: () => (modal ? {} : null) });
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  useKeymap(handlers, opts);
  const stop = hooks.effects.at(-1)!()!;
  const press = (init: Record<string, unknown>) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), ev(init));
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
  press(PRESS["Mod+J"]);
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
