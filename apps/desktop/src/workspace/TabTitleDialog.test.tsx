import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { TabTitleDialog, titleToSave } from "./TabTitleDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string) => translate("en", key);

it("an empty or blank title saves as a reset to the program's title", () => {
  expect(titleToSave("  build  ")).toBe("build");
  expect(titleToSave("")).toBeNull();
  expect(titleToSave("   ")).toBeNull();
});

it("renders the field prefilled with the current title, with Reset, Save and Cancel", () => {
  const html = renderToStaticMarkup(<TabTitleDialog title="npm run dev" onSave={() => {}} onCancel={() => {}} />);
  expect(html).toContain('value="npm run dev"');
  expect(html).toContain(en("tabMenu.title.heading"));
  expect(html).toContain(en("tabMenu.title.reset"));
  expect(html).toContain(en("tabMenu.title.save"));
  expect(html).toContain(en("tabMenu.title.cancel"));
  expect(html).toContain('class="dialog');
});
