import { beforeEach, expect, it, vi } from "vitest";
import { consumeSearchPrefill, requestSearch, resetSearchPrefill, subscribeSearchPrefill } from "./searchPrefill";

beforeEach(resetSearchPrefill);

it("notifies subscribers and hands the request over once", () => {
  const seen: unknown[] = [];
  subscribeSearchPrefill(() => seen.push(consumeSearchPrefill()));
  requestSearch({ query: "todo", include: "src/**" });
  expect(seen).toEqual([{ query: "todo", include: "src/**" }]);
  expect(consumeSearchPrefill()).toBeNull();
});

it("keeps a request nobody has taken yet", () => {
  requestSearch({ query: "a" });
  expect(consumeSearchPrefill()).toEqual({ query: "a" });
});

it("stops notifying after unsubscribe", () => {
  const listener = vi.fn();
  const off = subscribeSearchPrefill(listener);
  off();
  requestSearch({ query: "a" });
  expect(listener).not.toHaveBeenCalled();
});
