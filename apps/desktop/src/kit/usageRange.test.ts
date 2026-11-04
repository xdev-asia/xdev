import { expect, it } from "vitest";
import { rangeDays } from "./usageRange";

it("counts today as the last of the days", () => {
  expect(rangeDays("7", new Date(2026, 10, 4, 15, 30))).toEqual({ sinceDay: "2026-10-29", untilDay: "2026-11-04" });
  expect(rangeDays("30", new Date(2026, 10, 4))).toEqual({ sinceDay: "2026-10-06", untilDay: "2026-11-04" });
});
it("crosses a month and a year edge", () => {
  expect(rangeDays("7", new Date(2026, 2, 3))).toEqual({ sinceDay: "2026-02-25", untilDay: "2026-03-03" });
  expect(rangeDays("90", new Date(2026, 0, 10))).toEqual({ sinceDay: "2025-10-13", untilDay: "2026-01-10" });
  expect(rangeDays("7", new Date(2024, 2, 2))).toEqual({ sinceDay: "2024-02-25", untilDay: "2024-03-02" });
});
it("All time has no start day", () => {
  expect(rangeDays("all", new Date(2026, 10, 4))).toEqual({ sinceDay: null, untilDay: "2026-11-04" });
});
