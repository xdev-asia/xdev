import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Banner } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { mount, type Node } from "@/kit/testHooks";
import { createMockBrowser } from "@/mockBrowser";
import { BrowserTab } from "./BrowserTab";
import { browserTab, openBrowserTab, resetBrowserTabs } from "./browserTabs";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
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

it("a blocked popup shows the notice once, until it is dismissed", async () => {
  const browser = createMockBrowser();
  const id = openBrowserTab("/repo/a", { url: "https://example.com/" });
  const view = mount(BrowserTab, () => ({ api: { ...browser, openUrl: async () => {} }, entry: browserTab(id)!, visible: false }));
  const notice = (all: Node[]) => all.find((n) => n.type === Banner);
  expect(notice(await view.settle())).toBeUndefined();
  browser.__browserPopupBlocked("other-tab", "https://ads.example/");
  expect(notice(view.all())).toBeUndefined();
  browser.__browserPopupBlocked(id, "https://ads.example/");
  const shown = notice(view.all())!;
  expect(shown.props.title).toBe(en("browser.popupBlocked.title"));
  expect(shown.props.children).toBe(en("browser.popupBlocked.hint"));
  shown.props.action.props.onClick();
  expect(notice(view.all())).toBeUndefined();
});
