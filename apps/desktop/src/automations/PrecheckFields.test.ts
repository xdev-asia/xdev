import { expect, it } from "vitest";
import { translate } from "@/i18n";
import { timeoutLabel } from "./PrecheckFields";

it("names a stored timeout outside the options in the person's language", () => {
  const vi = (key: string, vars?: Record<string, string | number>) => translate("vi", key, vars);
  const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
  expect(timeoutLabel(60, vi)).toBe("1 phút");
  expect(timeoutLabel(45, vi)).toBe("45 giây");
  expect(timeoutLabel(45, en)).toBe("45 s");
});
