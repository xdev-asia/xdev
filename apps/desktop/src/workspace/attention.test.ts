import { expect, it } from "vitest";
import { STATUS_DEFAULTS } from "@/status/statusSettings";
import { admits, reasonKey } from "./attention";

it("reasonKey names each reason", () => {
  expect(reasonKey("needs-you")).toBe("attention.reason.needs-you");
  expect(reasonKey("done")).toBe("attention.reason.done");
  expect(reasonKey("failed")).toBe("attention.reason.failed");
  expect(reasonKey("bell")).toBe("attention.reason.bell");
});

it("admits follows the settings and treats null as needs-you", () => {
  const base = { ...STATUS_DEFAULTS, enabled: true, onNeedsInput: true, onDone: false, onFailed: true };
  expect(admits("done", base)).toBe(false);
  expect(admits("failed", base)).toBe(true);
  expect(admits(null, base)).toBe(true);
  expect(admits(null, { ...base, onNeedsInput: false })).toBe(false);
  expect(admits("needs-you", { ...base, enabled: false })).toBe(false);
});
