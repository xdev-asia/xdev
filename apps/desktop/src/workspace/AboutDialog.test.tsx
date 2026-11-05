import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { AboutDialog } from "./AboutDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("shows the version with the documentation and source links", () => {
  const html = renderToStaticMarkup(<AboutDialog version="0.3.0" onLink={() => {}} onClose={() => {}} />);
  expect(html).toContain(en("shell.help.about"));
  expect(html).toContain(en("shell.help.aboutVersion", { version: "0.3.0" }));
  expect(html).toContain(en("shell.help.docs"));
  expect(html).toContain(en("shell.help.source"));
  expect(html).toContain(en("shell.help.close"));
});
