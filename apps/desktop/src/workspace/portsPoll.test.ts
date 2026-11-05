import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPortsPoll } from "./portsPoll";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("scans at once and then every interval, until stopped", async () => {
  const scan = vi.fn(async () => {});
  const stop = startPortsPoll(scan, 5_000);
  expect(scan).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(scan).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(scan).toHaveBeenCalledTimes(4);
  stop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(scan).toHaveBeenCalledTimes(4);
});

it("skips a tick while the last scan is still running", async () => {
  let release: () => void = () => {};
  const scan = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
  const stop = startPortsPoll(scan, 1_000);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(scan).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(scan).toHaveBeenCalledTimes(2);
  stop();
});

it("a failed scan does not end the polling", async () => {
  const scan = vi.fn(async () => {
    throw new Error("boom");
  });
  const stop = startPortsPoll(scan, 1_000);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(scan).toHaveBeenCalledTimes(3);
  stop();
});
