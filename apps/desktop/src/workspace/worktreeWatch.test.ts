import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type FsChanged, type FsEvent } from "@/api";
import { FileTabs } from "@/files/fileTabs";
import { resetWatchState } from "@/files/fileWatch";
import { WorktreeWatch, type WatchHealth } from "./worktreeWatch";

const W = "/demo/wt/xdev-oak";
const t = (k: string) => k;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup() {
  const api = createMockApi({});
  const store = new FileTabs();
  const io = { api, store, t };
  const batches: FsEvent[][] = [];
  const health: WatchHealth[] = [];
  let send: ((c: FsChanged) => void) | null = null;
  const watch = vi.spyOn(api, "filesWatch").mockImplementation(async (_w, _id, on) => void (send = on));
  const make = () => new WorktreeWatch({ api, worktree: W, io: () => io, onBatch: (e) => batches.push(e), onHealth: (h) => health.push(h) });
  return { api, store, io, batches, health, watch, make, send: (c: FsChanged) => send!(c) };
}

beforeEach(() => resetWatchState());

it("a start refused for the watch limit says so", async () => {
  const s = setup();
  s.watch.mockRejectedValueOnce({ code: "watch_limit" });
  const w = s.make();
  w.start();
  await tick();
  expect(s.health.at(-1)).toBe<WatchHealth>("limit");
  w.stop();
});

it("a watcher that stops at the watch limit says so, and the batch still reaches the tree", async () => {
  const s = setup();
  const w = s.make();
  w.start();
  await tick();
  expect(s.health.at(-1)).toBe<WatchHealth>("live");
  s.send({ worktree: W, events: [{ kind: "overflow", rel: "", dir: null }], failure: "watchLimit" });
  expect(s.health.at(-1)).toBe<WatchHealth>("limit");
  expect(s.batches.at(-1)).toEqual([{ kind: "overflow", rel: "", dir: null }]);
  w.stop();
});
