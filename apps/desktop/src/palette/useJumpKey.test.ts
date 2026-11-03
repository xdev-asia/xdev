import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useJumpKey } from "./useJumpKey";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => void hooks.effects.push(effect),
}));

beforeEach(() => { hooks.effects = []; });
afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
  const listeners: { type: string; fn: (e: Event) => void; capture: unknown }[] = [];
  const win = {
    addEventListener: (type: string, fn: (e: Event) => void, capture?: unknown) => listeners.push({ type, fn, capture }),
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  vi.stubGlobal("window", win);
  const onToggle = vi.fn();
  useJumpKey(onToggle);
  const stop = hooks.effects.at(-1)!()!;
  const press = (init: Record<string, unknown>) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, repeat: false, key: "j" }, init);
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    listeners.forEach((l) => l.fn(event));
    return { event, stopPropagation };
  };
  return { onToggle, stop, press, listeners };
}

it("ctrl+j is taken in the capture phase", () => {
  const { onToggle, press, listeners } = setup();
  expect(listeners[0].capture).toBe(true);
  const { event, stopPropagation } = press({ ctrlKey: true });
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(true);
  expect(stopPropagation).toHaveBeenCalled();
});

it("meta+j works too", () => {
  const { onToggle, press } = setup();
  press({ metaKey: true, key: "J" });
  expect(onToggle).toHaveBeenCalledTimes(1);
});

it("shift, alt and repeat are ignored", () => {
  const { onToggle, press } = setup();
  press({ ctrlKey: true, shiftKey: true });
  press({ ctrlKey: true, altKey: true });
  press({ ctrlKey: true, repeat: true });
  expect(onToggle).not.toHaveBeenCalled();
});

it("plain j is ignored", () => {
  const { onToggle, press } = setup();
  const { event } = press({});
  press({ ctrlKey: true, key: "k" });
  expect(onToggle).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

it("unmount stops listening", () => {
  const { onToggle, press, stop, listeners } = setup();
  stop();
  expect(listeners).toHaveLength(0);
  press({ ctrlKey: true });
  expect(onToggle).not.toHaveBeenCalled();
});
