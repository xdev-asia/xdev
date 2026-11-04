import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { QuitDialog } from "./QuitDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("names the count and the working tabs, with Keep running, End all and Cancel", () => {
  const html = renderToStaticMarkup(
    <QuitDialog ask={{ count: 3, working: [{ id: "a", title: "Fix the parser" }] }} onChoose={() => {}} />,
  );
  expect(html).toContain(en("ptyd.quit.body", { count: 3 }));
  expect(html).toContain("Fix the parser");
  expect(html).toContain(en("ptyd.quit.keep"));
  expect(html).toContain(en("ptyd.quit.end"));
  expect(html).toContain(en("dialog.cancel"));
  expect(html).toContain('class="dialog');
});

it("leaves the working list out when no tab is working", () => {
  const html = renderToStaticMarkup(<QuitDialog ask={{ count: 1, working: [] }} onChoose={() => {}} />);
  expect(html).not.toContain(en("ptyd.quit.working"));
});
