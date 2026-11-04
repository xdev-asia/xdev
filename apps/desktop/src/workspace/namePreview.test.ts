import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NamePreview } from "@/api";
import { PREVIEW_DELAY_MS, schedulePreview } from "./namePreview";

const TAKEN: NamePreview = { branch: "feat-one-2", folder: "xdev-feat-one-2", suffixed: true };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("asks the backend once, after the name sits still for the delay", async () => {
  const load = vi.fn().mockResolvedValue(TAKEN);
  const onResult = vi.fn();
  const stop = schedulePreview(load, "r1", "feat one", onResult);
  vi.advanceTimersByTime(PREVIEW_DELAY_MS - 1);
  expect(load).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(load).toHaveBeenCalledExactlyOnceWith("r1", "feat one");
  await vi.advanceTimersByTimeAsync(0);
  expect(onResult).toHaveBeenCalledExactlyOnceWith(TAKEN);
  stop();
});

it("a newer name drops the pending lookup", async () => {
  const load = vi.fn().mockResolvedValue(TAKEN);
  const onResult = vi.fn();
  const stop = schedulePreview(load, "r1", "fe", onResult);
  vi.advanceTimersByTime(PREVIEW_DELAY_MS - 50);
  stop();
  schedulePreview(load, "r1", "feat", onResult);
  await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS);
  expect(load).toHaveBeenCalledExactlyOnceWith("r1", "feat");
});

it("an answer that arrives after a newer name is ignored", async () => {
  let answer!: (p: NamePreview) => void;
  const load = vi.fn(() => new Promise<NamePreview>((resolve) => { answer = resolve; }));
  const onResult = vi.fn();
  const stop = schedulePreview(load, "r1", "feat", onResult);
  vi.advanceTimersByTime(PREVIEW_DELAY_MS);
  stop();
  answer(TAKEN);
  await vi.advanceTimersByTimeAsync(0);
  expect(onResult).not.toHaveBeenCalled();
});

it("a blank name or no repo shows nothing and asks nothing", async () => {
  const load = vi.fn();
  const onResult = vi.fn();
  schedulePreview(load, "r1", "   ", onResult);
  schedulePreview(load, "", "feat", onResult);
  await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS * 2);
  expect(onResult.mock.calls).toEqual([[null], [null]]);
  expect(load).not.toHaveBeenCalled();
});

it("a failed lookup shows nothing", async () => {
  const load = vi.fn().mockRejectedValue({ code: "bad_name" });
  const onResult = vi.fn();
  schedulePreview(load, "r1", "...", onResult);
  await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS);
  expect(onResult).toHaveBeenCalledExactlyOnceWith(null);
});
