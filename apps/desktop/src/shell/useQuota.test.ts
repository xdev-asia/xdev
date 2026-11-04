import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import type { Quota } from "@/api";
import { createQuotaPoller } from "./useQuota";

const states = () => {
  const seen: { quota: Quota[] | null; loading: boolean }[] = [];
  return { seen, onChange: (s: { quota: Quota[] | null; loading: boolean }) => seen.push(s) };
};

it("reads on start and every five minutes until stopped", async () => {
  vi.useFakeTimers();
  try {
    const api = createMockApi({}); const expected = await api.quota(); const quota = vi.spyOn(api, "quota");
    const { seen, onChange } = states();
    const poller = createQuotaPoller(api, onChange);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual({ quota: expected, loading: false });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(quota).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(quota).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("falls back to null when quota cannot be read", async () => {
  const api = createMockApi({}); vi.spyOn(api, "quota").mockRejectedValue({ code: "io" });
  const { seen, onChange } = states();
  createQuotaPoller(api, onChange).start();
  await vi.waitFor(() => expect(seen.at(-1)).toEqual({ quota: null, loading: false }));
});
it("refresh reads now and restarts the timer", async () => {
  vi.useFakeTimers();
  try {
    const api = createMockApi({}); const quota = vi.spyOn(api, "quota");
    const poller = createQuotaPoller(api, () => {});
    poller.start();
    await vi.advanceTimersByTimeAsync(200_000);
    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(quota).toHaveBeenCalledTimes(2);
    // The old timer would fire at 300 s; the restarted one fires at 500 s.
    await vi.advanceTimersByTimeAsync(150_000);
    expect(quota).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(quota).toHaveBeenCalledTimes(3);
    poller.stop();
  } finally { vi.useRealTimers(); }
});
it("ignores refresh while a read is running and shows loading", async () => {
  const api = createMockApi({});
  let release: (q: Quota[]) => void = () => {};
  const quota = vi.spyOn(api, "quota").mockImplementation(() => new Promise((r) => { release = r; }));
  const { seen, onChange } = states();
  const poller = createQuotaPoller(api, onChange);
  poller.start();
  expect(seen.at(-1)?.loading).toBe(true);
  poller.refresh(); poller.refresh();
  expect(quota).toHaveBeenCalledTimes(1);
  release([]);
  await vi.waitFor(() => expect(seen.at(-1)).toEqual({ quota: [], loading: false }));
  poller.stop();
});
