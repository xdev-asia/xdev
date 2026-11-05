import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";

vi.mock("@/i18n", async (orig) => {
  const real = await orig<typeof import("@/i18n")>();
  return { ...real, useI18n: () => ({ t: (k: string, v?: Record<string, string | number>) => real.translate("en", k, v) }) };
});

import { ExperimentalPage, EXPERIMENTAL_FEATURES } from "./ExperimentalPage";
import { SECTIONS } from "./sections";

const t = (k: string) => translate("en", k);

it("lists the experimental features with a link to where they live", () => {
  const html = renderToStaticMarkup(createElement(ExperimentalPage, { api: {} as never, onChanged() {} }));
  expect(html).toContain(t("settings.experimental.title"));
  expect(html).toContain(t("settings.agents.autoSleep.label"));
  expect(html).toContain(t("settings.experimental.autoSleep.open"));
  for (const f of EXPERIMENTAL_FEATURES) expect(SECTIONS.some((s) => s.id === f.section)).toBe(true);
});
