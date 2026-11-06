import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { createMockBrowser } from "@/mockBrowser";
import { BrowserTab } from "./BrowserTab";
import { browserTab, openBrowserTab, resetBrowserTabs } from "./browserTabs";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string) => translate("en", key);
const api = { ...createMockBrowser(), openUrl: async () => {} };

afterEach(() => resetBrowserTabs());

it("the toolbar names every control and shows the page's address", () => {
  const id = openBrowserTab("/repo/a", { url: "https://example.com/" });
  const html = renderToStaticMarkup(<BrowserTab api={api} entry={browserTab(id)!} visible />);
  for (const key of ["browser.toolbar", "browser.back", "browser.forward", "browser.reload", "browser.address", "browser.openSystem", "browser.devtools"]) {
    expect(html).toContain(en(key));
  }
  expect(html).toContain('value="https://example.com/"');
  expect(html).toContain('role="toolbar"');
  expect(html).not.toContain('role="alert"');
});

it("a blank tab shows an empty field and cannot open in the system browser", () => {
  const id = openBrowserTab("/repo/a");
  const html = renderToStaticMarkup(<BrowserTab api={api} entry={browserTab(id)!} visible />);
  expect(html).toContain('value=""');
  expect(html).toContain(`placeholder="${en("browser.addressPlaceholder")}"`);
  expect(html).toMatch(new RegExp(`aria-label="${en("browser.openSystem")}"[^>]*disabled`));
});
