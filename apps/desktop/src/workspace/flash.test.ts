import { expect, it } from "vitest";
import { FLASH_MS, flash } from "./flash";

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  return {
    pending,
    timers: {
      setTimeout: (cb: () => void, ms: number) => (pending.set(next, { cb, ms }), next++),
      clearTimeout: (id: number) => void pending.delete(id),
    },
    fire: () => [...pending.entries()].forEach(([id, t]) => (pending.delete(id), t.cb())),
  };
}

it("sets data-flash and removes it after the delay", () => {
  const t = fakeTimers();
  const el = { dataset: {} as Record<string, string | undefined> };
  flash(el, FLASH_MS, t.timers);
  expect(FLASH_MS).toBe(900);
  expect(el.dataset.flash).toBe("");
  expect([...t.pending.values()][0].ms).toBe(900);
  t.fire();
  expect(el.dataset.flash).toBeUndefined();
});

it("a second flash restarts the timer", () => {
  const t = fakeTimers();
  const el = { dataset: {} as Record<string, string | undefined> };
  flash(el, 900, t.timers);
  flash(el, 900, t.timers);
  expect(t.pending.size).toBe(1);
  expect(el.dataset.flash).toBe("");
});

it("a null element is a no-op", () => {
  const t = fakeTimers();
  flash(null, 900, t.timers);
  expect(t.pending.size).toBe(0);
});
