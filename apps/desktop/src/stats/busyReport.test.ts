import { expect, it, vi } from "vitest";
import type { Sessions, Tab } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";
import { startBusyReport } from "./busyReport";

type Listener = (tab: Tab, from: TabStatus, to: TabStatus, at: number) => void;

function harness(busy: (id: string, working: boolean) => Promise<void> = async () => {}) {
  const listeners = new Set<Listener>();
  const appStatsBusy = vi.fn(busy);
  const sessions = {
    onStatus(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as Pick<Sessions, "onStatus">;
  const stop = startBusyReport({ appStatsBusy }, sessions);
  const emit = (id: string, from: TabStatus, to: TabStatus, agent = true) => {
    for (const l of [...listeners]) l({ id, agent } as Tab, from, to, 0);
  };
  return { appStatsBusy, emit, stop, listeners };
}

it("sends true once on the edge into working", () => {
  const h = harness();
  h.emit("a", "idle", "working");
  h.emit("a", "working", "working");
  expect(h.appStatsBusy.mock.calls).toEqual([["a", true]]);
});

it("sends false on the edge out of working", () => {
  const h = harness();
  h.emit("a", "idle", "working");
  h.emit("a", "working", "done");
  expect(h.appStatsBusy.mock.calls).toEqual([["a", true], ["a", false]]);
});

it("sends true again when a tab returns to working", () => {
  const h = harness();
  h.emit("a", "idle", "working");
  h.emit("a", "working", "needs-you");
  h.emit("a", "needs-you", "working");
  expect(h.appStatsBusy.mock.calls).toEqual([["a", true], ["a", false], ["a", true]]);
});

it("ignores tabs that are not agents", () => {
  const h = harness();
  h.emit("s", "idle", "working", false);
  expect(h.appStatsBusy).not.toHaveBeenCalled();
});

it("does not throw when the call rejects or throws", () => {
  const rejecting = harness(() => Promise.reject(new Error("no")));
  expect(() => rejecting.emit("a", "idle", "working")).not.toThrow();
  const throwing = harness(() => {
    throw new Error("no");
  });
  expect(() => throwing.emit("a", "idle", "working")).not.toThrow();
});

it("on stop sends false for live ids only and unsubscribes", () => {
  const h = harness();
  h.emit("a", "idle", "working");
  h.emit("b", "idle", "working");
  h.emit("b", "working", "done");
  h.appStatsBusy.mockClear();
  h.stop();
  expect(h.appStatsBusy.mock.calls).toEqual([["a", false]]);
  expect(h.listeners.size).toBe(0);
});
