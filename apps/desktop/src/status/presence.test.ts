import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRESENCE_MS, watchPresence } from "./presence";

type Listener = (e: Event) => void;

function target() {
  const map = new Map<string, Listener>();
  return {
    map,
    addEventListener: (name: string, fn: Listener) => void map.set(name, fn),
    removeEventListener: (name: string) => void map.delete(name),
    fire: (name: string, trusted = true) => map.get(name)?.({ isTrusted: trusted } as Event),
  };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("is present at first, absent after 180 s without input, present again on a trusted event", () => {
  const win = target();
  const seen: boolean[] = [];
  watchPresence(win as never, (p) => seen.push(p));
  vi.advanceTimersByTime(PRESENCE_MS - 1);
  expect(seen).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(seen).toEqual([false]);
  win.fire("keydown");
  expect(seen).toEqual([false, true]);
  vi.advanceTimersByTime(PRESENCE_MS);
  expect(seen).toEqual([false, true, false]);
});

it("each of keydown, pointerdown and wheel counts, and each restarts the 180 s", () => {
  const win = target();
  const seen: boolean[] = [];
  watchPresence(win as never, (p) => seen.push(p));
  expect([...win.map.keys()].sort()).toEqual(["keydown", "pointerdown", "wheel"]);
  for (const name of ["keydown", "pointerdown", "wheel"]) {
    vi.advanceTimersByTime(PRESENCE_MS - 1000);
    win.fire(name);
  }
  expect(seen).toEqual([]);
  vi.advanceTimersByTime(PRESENCE_MS - 1);
  expect(seen).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(seen).toEqual([false]);
});

it("a scripted event proves nothing", () => {
  const win = target();
  const seen: boolean[] = [];
  watchPresence(win as never, (p) => seen.push(p));
  vi.advanceTimersByTime(PRESENCE_MS - 1);
  win.fire("keydown", false);
  vi.advanceTimersByTime(1);
  expect(seen).toEqual([false]);
  win.fire("wheel", false);
  expect(seen).toEqual([false]);
});

it("stopping removes the listeners and the timer", () => {
  const win = target();
  const stop = watchPresence(win as never, () => {});
  stop();
  expect(win.map.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
