import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Check } from "@/api";
import { translate } from "@/i18n";
import { ChecksTriage } from "./ChecksTriage";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const c = (bucket: Check["bucket"], name: string = bucket): Check => ({ name, workflow: "ci", bucket, link: null });
const html = (checks: Check[], onFix?: () => void) => renderToStaticMarkup(<ChecksTriage checks={checks} onFix={onFix} />);

it("says nothing when all is well", () => {
  expect(html([c("pass")])).toBe("");
  expect(html([])).toBe("");
});

it("names the first kind that has a check", () => {
  expect(html([c("fail"), c("cancel"), c("pending")])).toContain(en("checks.triage.failing.one", { count: 1 }));
  expect(html([c("fail", "a"), c("fail", "b")])).toContain(en("checks.triage.failing", { count: 2 }));
  expect(html([c("cancel"), c("pending")])).toContain(en("checks.triage.cancelled.one", { count: 1 }));
  expect(html([c("pending"), c("pass")])).toContain(en("checks.triage.pending.one", { count: 1 }));
  expect(html([c("skipping")])).toContain(en("checks.triage.unresolved.one", { count: 1 }));
  expect(html([c("skipping"), c("pass")])).toBe("");
});

it("offers Fix only for failures and with a handler", () => {
  expect(html([c("fail")], () => {})).toContain("data-fix-all");
  expect(html([c("fail")])).not.toContain("data-fix-all");
  expect(html([c("pending")], () => {})).not.toContain("data-fix-all");
});
