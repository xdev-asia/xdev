import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dismissToast, getToasts, pushToast, resetToastsForTests } from "./toastStore";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetToastsForTests();
  vi.useRealTimers();
});

it("keeps three, newest last", () => {
  for (const text of ["a", "b", "c", "d"]) pushToast({ text });
  expect(getToasts().map((t) => t.text)).toEqual(["b", "c", "d"]);
});

it("the same id replaces in place", () => {
  pushToast({ id: "x", text: "one" });
  pushToast({ id: "y", text: "two" });
  pushToast({ id: "x", text: "three" });
  expect(getToasts().map((t) => t.text)).toEqual(["three", "two"]);
});

it("goes after its ttl, and a ttl of 0 stays", () => {
  pushToast({ text: "short", ttlMs: 1000 });
  pushToast({ text: "kept", ttlMs: 0 });
  vi.advanceTimersByTime(1000);
  expect(getToasts().map((t) => t.text)).toEqual(["kept"]);
  vi.advanceTimersByTime(60_000);
  expect(getToasts()).toHaveLength(1);
  dismissToast(getToasts()[0].id);
  expect(getToasts()).toHaveLength(0);
});
