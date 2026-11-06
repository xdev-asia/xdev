import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { PdfFindBar, findKey } from "./PdfFindBar";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const bar = (over: Partial<Parameters<typeof PdfFindBar>[0]> = {}) =>
  renderToStaticMarkup(<PdfFindBar query="hello" count={3} current={1} searching={null} onQuery={() => {}} onStep={() => {}} onClose={() => {}} {...over} />);

describe("findKey", () => {
  const press = (key: string, shiftKey = false) => {
    const on = { onStep: vi.fn(), onClose: vi.fn() };
    const e = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    return { handled: findKey(e, on), on, e };
  };
  it("steps forward on Enter and back on Shift+Enter", () => {
    expect(press("Enter").on.onStep).toHaveBeenCalledWith(1);
    expect(press("Enter", true).on.onStep).toHaveBeenCalledWith(-1);
  });
  it("closes on Escape without letting it bubble", () => {
    const { on, e } = press("Escape");
    expect(on.onClose).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalled();
  });
  it("leaves other keys alone", () => {
    const { handled, on } = press("a");
    expect(handled).toBe(false);
    expect(on.onStep).not.toHaveBeenCalled();
    expect(on.onClose).not.toHaveBeenCalled();
  });
});

describe("PdfFindBar", () => {
  it("is a search landmark with a labelled field holding the query", () => {
    const html = bar();
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="Find in PDF"');
    expect(html).toContain('value="hello"');
  });
  it("counts across the document", () => {
    expect(bar()).toContain("2 of 3");
  });
  it("shows progress while pages are still being read", () => {
    expect(bar({ searching: { n: 4, m: 12 } })).toContain("Searching");
  });
  it("says so when nothing matches, and disables stepping", () => {
    const html = bar({ count: 0, current: -1 });
    expect(html).toContain("No matches");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("shows no status for an empty query", () => {
    expect(bar({ query: "", count: 0, current: -1 })).not.toContain("No matches");
  });
});
