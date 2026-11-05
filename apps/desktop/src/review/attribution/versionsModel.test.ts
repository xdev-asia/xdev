import { expect, it } from "vitest";
import type { FileVersion } from "@/api";
import { canRestore, delayUntilNext, flow, START } from "./versionsModel";

const v = (id: string): FileVersion => ({ id, at: 1, size: 3, tabId: "t1", agent: "claude" });

it("a restore is asked only after a version is picked", () => {
  expect(flow(START, { type: "ask" })).toEqual(START);
  const picked = flow(START, { type: "pick", version: v("a") });
  expect(picked).toEqual({ picked: v("a"), confirming: false });
  expect(flow(picked, { type: "ask" }).confirming).toBe(true);
});

it("cancel and a finished restore close the question; picking another version closes it too", () => {
  const asked = flow(flow(START, { type: "pick", version: v("a") }), { type: "ask" });
  expect(flow(asked, { type: "cancel" }).confirming).toBe(false);
  expect(flow(asked, { type: "restored" }).confirming).toBe(false);
  expect(flow(asked, { type: "pick", version: v("b") })).toEqual({ picked: v("b"), confirming: false });
});

it("restoring the version the file already has is not offered", () => {
  const picked = flow(START, { type: "pick", version: v("a") });
  expect(canRestore(picked, "same", "same")).toBe(false);
  expect(canRestore(picked, "now", "then")).toBe(true);
  expect(canRestore(picked, "now", null)).toBe(false);
  expect(canRestore(START, "now", "then")).toBe(false);
});

it("reads stay two seconds apart", () => {
  expect(delayUntilNext(10_000, 10_500, 2000)).toBe(1500);
  expect(delayUntilNext(10_000, 12_000, 2000)).toBe(0);
  expect(delayUntilNext(10_000, 99_000, 2000)).toBe(0);
});
