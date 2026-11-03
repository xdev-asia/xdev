import { expect, it, vi } from "vitest";
import { createMockApi } from "../api";
import { PrStore } from "./prs";

const OAK = "/demo/wt/xdev-oak";

it("one load per path at a time", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreePr");
  const store = new PrStore(api);
  const seen = vi.fn();
  store.subscribe(seen);
  const a = store.load(OAK);
  const b = store.load(OAK);
  expect(b).toBe(a);
  await a;
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.get(OAK)).toEqual({ pr: null, checks: null });
  expect(seen).toHaveBeenCalled();
  expect(store.snapshot()).toBeGreaterThan(0);
  await store.load(OAK);
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps errors per path", async () => {
  const api = createMockApi({});
  const store = new PrStore(api);
  await store.load("/nowhere");
  await store.load(OAK);
  expect(store.get("/nowhere")?.error?.code).toBe("worktree_unknown");
  expect(store.get(OAK)?.error).toBeUndefined();
});

it("loads checks only when asked and a pull request exists", async () => {
  const api = createMockApi({});
  const checks = vi.spyOn(api, "worktreePrChecks");
  const store = new PrStore(api);
  await store.load(OAK, { checks: true });
  expect(checks).not.toHaveBeenCalled();
  store.set(OAK, { number: 3, url: "u", state: "open", title: "t", base: "main", head: "oak" });
  expect(store.get(OAK)?.pr?.number).toBe(3);
});
