import { expect, it } from "vitest";
import en from "@/i18n/en.json";
import { formatBusy } from "./formatBusy";

const dict = en as Record<string, string>;
const t = (key: string, vars?: Record<string, string | number>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ""));

it("shows 0m for zero, negative and non-finite times", () => {
  expect(formatBusy(0, t)).toBe("0m");
  expect(formatBusy(-5, t)).toBe("0m");
  expect(formatBusy(Number.NaN, t)).toBe("0m");
  expect(formatBusy(Number.POSITIVE_INFINITY, t)).toBe("0m");
});

it("rounds down to whole minutes", () => {
  expect(formatBusy(59_999, t)).toBe("0m");
  expect(formatBusy(60_000, t)).toBe("1m");
  expect(formatBusy(59 * 60_000 + 59_000, t)).toBe("59m");
});

it("shows hours with minutes, then days with hours", () => {
  expect(formatBusy(3_660_000, t)).toBe("1h 1m");
  expect(formatBusy(23 * 3_600_000 + 59 * 60_000, t)).toBe("23h 59m");
  expect(formatBusy(90_000_000, t)).toBe("1d 1h");
});
