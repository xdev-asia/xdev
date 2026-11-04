import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";

vi.mock("@/i18n", async (orig) => {
  const real = await orig<typeof import("@/i18n")>();
  return { ...real, useI18n: () => ({ t: (k: string, v?: Record<string, string | number>) => real.translate("en", k, v) }) };
});

import { StartupBannerView } from "./StartupBanner";
import { failedSteps, startupText } from "./startupSteps";

const step = (id: string, ok: boolean, detail?: string) => ({ id, ok, ms: 3, detail });
const render = (steps: ReturnType<typeof step>[]) =>
  renderToStaticMarkup(createElement(StartupBannerView, { steps, onRestart() {}, onCopy() {} }));
const en = (k: string) => translate("en", k);

it("is hidden when every step is ok", () => {
  expect(render([step("settings", true), step("logs", true)])).toBe("");
});

it("is hidden when only ptyd failed", () => {
  expect(render([step("ptyd", false, "fallback"), step("settings", true)])).toBe("");
});

it("lists the labels of the failed steps with Copy details", () => {
  const html = render([step("settings", false, "not an object"), step("logs", false), step("data_dir", true)]);
  expect(html).toContain(en("startup.step.settings"));
  expect(html).toContain(en("startup.step.logs"));
  expect(html).not.toContain(en("startup.step.data_dir"));
  expect(html).toContain(en("startup.copy"));
  expect(html).not.toContain(en("startup.restart"));
});

it("offers Restart now for a failed layout restore, as a secondary action", () => {
  const html = render([step("layout.restore", false, "did not parse")]);
  expect(html).toContain(en("startup.restart"));
  expect(html).not.toContain(en("startup.copy"));
  expect(html).toContain("btn-secondary");
  expect(html).not.toMatch(/class="btn"/);
});

it("an unknown step gets the generic label", () => {
  expect(render([step("brand_new", false)])).toContain(en("startup.step.other"));
});

it("the copy text has one [startup] line per step", () => {
  const failed = failedSteps([step("settings", false, "bad"), step("ptyd", false), step("logs", true)]);
  expect(startupText(failed)).toBe("[startup] settings ok=false t=3 detail=bad");
});
