import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { THEME_FILE_EXTENSIONS, ThemeColours, importErrorKey } from "./ThemeColours";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const render = () => renderToStaticMarkup(<ThemeColours api={{} as never} active="" onSelect={async () => {}} />);
const button = (html: string, action: string) => html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? "";

describe("ThemeColours", () => {
  it("shows the group, the row and the five actions", () => {
    const html = render();
    expect(html).toContain(translate("en", "settings.appearance.colours.title"));
    expect(html).toContain(translate("en", "settings.appearance.colours.hint"));
    for (const action of ["new", "edit", "import", "export", "delete"]) expect(button(html, action)).not.toBe("");
  });

  it("disables Edit, Export and Delete on Default, not New or Import", () => {
    const html = render();
    for (const action of ["edit", "export", "delete"]) expect(button(html, action)).toContain("disabled");
    for (const action of ["new", "import"]) expect(button(html, action)).not.toContain("disabled");
  });

  it("has no primary button and an empty status", () => {
    const html = render();
    expect(html).not.toContain('type="submit"');
    expect(html).toMatch(/role="status"[^>]*><\/p>/);
  });

  it("asks for theme files by extension", () => {
    expect(THEME_FILE_EXTENSIONS).toContain("xdev-theme");
  });

  it("maps an import error to its message key", () => {
    expect(importErrorKey({ code: "theme_too_large" })).toBe("settings.appearance.colours.error.large");
    expect(importErrorKey({ code: "theme_invalid", detail: "format" })).toBe("settings.appearance.colours.error.file");
    expect(importErrorKey({ code: "io" })).toBe("settings.appearance.colours.error.save");
  });
});
