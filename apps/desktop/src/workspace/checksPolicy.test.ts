import { describe, expect, it } from "vitest";
import type { Check } from "../api";
import {
  POLL_BASE_MS,
  POLL_ERROR_MAX_MS,
  POLL_IDLE_MAX_MS,
  canRerunUnsuccessful,
  failingChecks,
  nextDelay,
  shouldPoll,
  triage,
} from "./checksPolicy";

const check = (bucket: Check["bucket"], name: string = bucket): Check => ({
  name,
  workflow: null,
  bucket,
  link: null,
});

describe("nextDelay", () => {
  it("backs off from 60 s to 120 s while nothing changes, and stops there", () => {
    expect(nextDelay(POLL_BASE_MS, "same")).toBe(POLL_IDLE_MAX_MS);
    expect(nextDelay(POLL_IDLE_MAX_MS, "same")).toBe(POLL_IDLE_MAX_MS);
  });
  it("resets to 60 s on a change", () => {
    expect(nextDelay(POLL_IDLE_MAX_MS, "changed")).toBe(POLL_BASE_MS);
    expect(nextDelay(POLL_ERROR_MAX_MS, "changed")).toBe(POLL_BASE_MS);
  });
  it("doubles on errors from 60 s up to 15 min", () => {
    let d = POLL_BASE_MS;
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      d = nextDelay(d, "error");
      seen.push(d);
    }
    expect(seen).toEqual([
      120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 900_000,
    ]);
  });
  it("comes back from a long error wait to the idle wait, not the error wait", () => {
    expect(nextDelay(POLL_ERROR_MAX_MS, "same")).toBe(POLL_IDLE_MAX_MS);
  });
});

describe("shouldPoll", () => {
  it("needs the panel and the window visible", () => {
    expect(shouldPoll({ panelVisible: true, windowVisible: true })).toBe(true);
    expect(shouldPoll({ panelVisible: false, windowVisible: true })).toBe(
      false,
    );
    expect(shouldPoll({ panelVisible: true, windowVisible: false })).toBe(
      false,
    );
  });
});

describe("triage", () => {
  it("names the first kind that has a check", () => {
    expect(
      triage([
        check("fail"),
        check("fail", "b"),
        check("cancel"),
        check("pending"),
      ]),
    ).toEqual({ kind: "failing", count: 2 });
    expect(triage([check("cancel"), check("pending")])).toEqual({
      kind: "cancelled",
      count: 1,
    });
    expect(triage([check("pending"), check("pass")])).toEqual({
      kind: "pending",
      count: 1,
    });
  });
  it("calls checks that only skipped unresolved", () => {
    expect(triage([check("skipping"), check("skipping", "b")])).toEqual({
      kind: "unresolved",
      count: 2,
    });
    expect(triage([check("skipping"), check("pass")])).toEqual({
      kind: "none",
      count: 0,
    });
  });
  it("has nothing to say about no checks or all passing", () => {
    expect(triage([])).toEqual({ kind: "none", count: 0 });
    expect(triage([check("pass")])).toEqual({ kind: "none", count: 0 });
  });
});

describe("check helpers", () => {
  it("fix takes the failing checks only", () => {
    expect(
      failingChecks([check("fail"), check("cancel"), check("pass")]).map(
        (c) => c.bucket,
      ),
    ).toEqual(["fail"]);
  });
  it("rerun unsuccessful needs a failed or cancelled check", () => {
    expect(canRerunUnsuccessful([check("pass"), check("pending")])).toBe(false);
    expect(canRerunUnsuccessful([check("cancel")])).toBe(true);
    expect(canRerunUnsuccessful([check("fail")])).toBe(true);
  });
});
