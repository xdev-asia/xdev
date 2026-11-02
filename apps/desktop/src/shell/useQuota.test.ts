import { beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "../api";
import { useQuota } from "./useQuota";

const hooks = vi.hoisted(() => ({ value: undefined as unknown, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    if (hooks.value === undefined) hooks.value = initial;
    return [hooks.value, (v: unknown) => { hooks.value = v; }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => { hooks.value = undefined; hooks.effects = []; });

it("reads on start and every five minutes until disposed", async () => {
  vi.useFakeTimers();
  try {
    const api = createMockApi({}); const expected = await api.quota(); const quota = vi.spyOn(api, "quota");
    useQuota(api, false); const stop = hooks.effects[0](); await tick();
    expect(quota).toHaveBeenCalledTimes(1);
    expect(hooks.value).toEqual(expected);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(quota).toHaveBeenCalledTimes(2);
    if (typeof stop === "function") stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(quota).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("does not read while paused", () => {
  const api = createMockApi({}); const quota = vi.spyOn(api, "quota");
  useQuota(api, true); expect(hooks.effects[0]()).toBeUndefined();
  expect(quota).not.toHaveBeenCalled();
});
it("falls back to null when quota cannot be read", async () => {
  const api = createMockApi({}); vi.spyOn(api, "quota").mockRejectedValue({ code: "io" });
  useQuota(api, false); hooks.effects[0](); await tick();
  expect(hooks.value).toBeNull();
});
