import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../i18n/en.json";
import { translate } from "../i18n";
import { LanguageSwitch } from "./LanguageSwitch";

const setLocale = vi.fn();
vi.mock("../i18n", async (original) => ({
  ...(await original<typeof import("../i18n")>()),
  useI18n: () => ({ locale: "vi", setLocale, t: (key: string) => translate("en", key) }),
}));

describe("LanguageSwitch", () => {
  it("is a labelled dropdown with the current locale chosen", () => {
    const html = renderToStaticMarkup(LanguageSwitch());
    expect(html).toContain(`<select class="lang-select" aria-label="${en["language.label"]}"`);
    expect(html).toContain(`<option value="vi" lang="vi" selected="">${en["language.vi"]}</option>`);
    expect(html).toContain(`<option value="en" lang="en">${en["language.en"]}</option>`);
  });

  it("switches the locale on change", () => {
    const select = LanguageSwitch() as ReactElement<{ onChange: (e: unknown) => void }>;
    select.props.onChange({ target: { value: "en" } });
    expect(setLocale).toHaveBeenCalledWith("en");
  });
});
