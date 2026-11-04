import { expect, it, vi } from "vitest";
import type { Sessions, Tab } from "@/workspace/sessions";
import { ActivityFeed, FEED_CAP } from "./feed";

const tab = (id: string, over: Partial<Tab> = {}) => ({ id, worktree: "/w", profileId: "claude", agent: true, ...over }) as Tab;

it("lists entries newest first, with the tab, the change and the time", () => {
  const feed = new ActivityFeed();
  feed.record(tab("a"), "idle", "working", 10);
  feed.record(tab("b", { worktree: "/x" }), "working", "needs-you", 20);
  const [first, second] = feed.snapshot();
  expect(first).toMatchObject({ tabId: "b", worktree: "/x", from: "working", to: "needs-you", at: 20 });
  expect(second).toMatchObject({ tabId: "a", worktree: "/w", from: "idle", to: "working", at: 10 });
  expect(first!.id).not.toBe(second!.id);
});

it("keeps at most FEED_CAP entries, the newest", () => {
  const feed = new ActivityFeed();
  for (let i = 0; i < FEED_CAP + 25; i++) feed.record(tab("a"), "idle", "working", i);
  const list = feed.snapshot();
  expect(FEED_CAP).toBe(200);
  expect(list).toHaveLength(FEED_CAP);
  expect(list[0]!.at).toBe(FEED_CAP + 24);
  expect(list[list.length - 1]!.at).toBe(25);
});

it("drops a done that rests as idle: it is noise after the done", () => {
  const feed = new ActivityFeed();
  feed.record(tab("a"), "working", "done", 1);
  feed.record(tab("a"), "done", "idle", 2);
  expect(feed.snapshot().map((e) => e.to)).toEqual(["done"]);
  // Idle after anything else is kept.
  feed.record(tab("a"), "working", "idle", 3);
  expect(feed.snapshot().map((e) => e.to)).toEqual(["idle", "done"]);
});

it("the snapshot is the same array until something is recorded, and listeners hear each change", () => {
  const feed = new ActivityFeed();
  const heard = vi.fn();
  const off = feed.subscribe(heard);
  const empty = feed.snapshot();
  expect(feed.snapshot()).toBe(empty);
  feed.record(tab("a"), "idle", "working", 1);
  expect(feed.snapshot()).not.toBe(empty);
  expect(heard).toHaveBeenCalledTimes(1);
  const now = feed.snapshot();
  feed.record(tab("a"), "done", "idle", 2);
  expect(feed.snapshot()).toBe(now);
  expect(heard).toHaveBeenCalledTimes(1);
  off();
  feed.record(tab("a"), "working", "failed", 3);
  expect(heard).toHaveBeenCalledTimes(1);
});

it("follows Sessions.onStatus until it is stopped", () => {
  let listener: (tab: Tab, from: Tab["status"], to: Tab["status"], at: number) => void = () => {};
  const off = vi.fn();
  const sessions = { onStatus: (l: typeof listener) => ((listener = l), off) } as unknown as Pick<Sessions, "onStatus">;
  const feed = new ActivityFeed();
  const stop = feed.follow(sessions);
  listener(tab("a"), "idle", "working", 5);
  expect(feed.snapshot()).toHaveLength(1);
  stop();
  expect(off).toHaveBeenCalledTimes(1);
});

it("clear empties the feed", () => {
  const feed = new ActivityFeed();
  feed.record(tab("a"), "idle", "working", 1);
  feed.clear();
  expect(feed.snapshot()).toEqual([]);
});
