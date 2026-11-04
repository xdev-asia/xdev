import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrashReport, RenderCrash } from "@/api";
import { crashKey, firstSight, onSurfaceReport, reportSurfaceCrash, resetSurfaceReports } from "./surfaceReport";

const crash = (n: number): RenderCrash => ({
  boundary: "b",
  surface: "s",
  name: "Error",
  message: `m${n}`,
  stack: null,
  componentStack: null,
  context: [],
});

describe("surface reports", () => {
  beforeEach(resetSurfaceReports);

  it("reports the same error once", async () => {
    const api = { crashRecordRender: vi.fn(async () => null) };
    await reportSurfaceCrash(api, crash(1));
    await reportSurfaceCrash(api, crash(1));
    expect(api.crashRecordRender).toHaveBeenCalledTimes(1);
  });

  it("forgets the oldest of 50 keys", () => {
    for (let i = 0; i < 51; i++) expect(firstSight(crashKey(crash(i)))).toBe(true);
    expect(firstSight(crashKey(crash(50)))).toBe(false);
    expect(firstSight(crashKey(crash(0)))).toBe(true);
  });

  it("tells listeners about a new report and survives a failing store", async () => {
    const seen: CrashReport[] = [];
    const off = onSurfaceReport((r) => seen.push(r));
    const report = { id: "r" } as CrashReport;
    await reportSurfaceCrash({ crashRecordRender: async () => report }, crash(1));
    expect(seen).toEqual([report]);
    off();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      reportSurfaceCrash({ crashRecordRender: async () => Promise.reject(new Error("x")) }, crash(2)),
    ).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});
