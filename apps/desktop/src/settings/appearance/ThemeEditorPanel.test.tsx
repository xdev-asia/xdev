import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import type { AppTheme } from "@/api";
import { ThemeEditorPanel, saveErrorKey, themeInput } from "./ThemeEditorPanel";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

vi.mock("@/ui/appTheme", () => {
  const colors = {
    "bg-0": "#0b0b0d", "bg-1": "#101013", "bg-2": "#16161a", "bg-3": "#1e1e23", term: "#09090b", "side-tint": "#131724",
    "text-1": "#e8e8ec", "text-2": "#8e8e98", "text-3": "#62626c", line: "#232329", accent: "#2f62e6", signal: "#5bd8ff",
    ok: "#4ade9b", warn: "#f2b544", danger: "#ff7a7a", violet: "#b69cff", orange: "#f0a070",
  };
  return {
    readBuiltIn: () => ({ colors, onAccent: "#ffffff" }),
    paintedMode: () => "dark",
    previewAppTheme: () => {},
    endPreview: () => {},
  };
});

const api = { appThemeSave: vi.fn(), terminalThemes: vi.fn(async () => []) };
const render = (theme: AppTheme | null = null) =>
  renderToStaticMarkup(<ThemeEditorPanel api={api as never} theme={theme} onSaved={() => {}} onCancel={() => {}} />);

describe("ThemeEditorPanel", () => {
  it("a new theme shows the name field, every group and one field per token", () => {
    const html = render();
    expect(html).toContain(translate("en", "settings.appearance.colours.panel.new"));
    expect(html).toContain(translate("en", "settings.appearance.colours.name"));
    expect(html.match(/class="theme-group"/g)).toHaveLength(5);
    expect(html.match(/class="colour-field"/g)).toHaveLength(17);
  });

  it("has exactly one submit button, Save", () => {
    const html = render();
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toContain(translate("en", "settings.appearance.colours.save"));
    expect(html).toContain(translate("en", "settings.appearance.colours.cancel"));
    expect(html).toContain(translate("en", "settings.appearance.colours.resetAll"));
  });

  it("an edit shows the theme name and its terminal scheme", () => {
    const theme: AppTheme = { id: "night", name: "Night", dark: {}, light: {}, terminalScheme: "nord" } as AppTheme;
    const html = render(theme);
    expect(html).toContain('value="Night"');
    expect(html).toContain(translate("en", "settings.appearance.colours.terminal.keep"));
  });

  it("reports a failing pair and no pass note", () => {
    const theme: AppTheme = { id: "dim", name: "Dim", dark: { "text-1": "#0b0b0e" }, light: {} } as AppTheme;
    const html = render(theme);
    expect(html).toContain("theme-contrast-list");
    expect(html).not.toContain('data-field="contrast-pass"');
    expect(render()).toContain('data-field="contrast-pass"');
  });
});

describe("themeInput", () => {
  it("trims the name and sends the scheme only when one is picked", () => {
    expect(themeInput(undefined, { name: " Night ", dark: { accent: "#ffffff" }, light: {}, terminalScheme: "" })).toEqual({
      name: "Night",
      dark: { accent: "#ffffff" },
      light: {},
    });
    expect(themeInput("night", { name: "Night", dark: {}, light: {}, terminalScheme: "nord" })).toEqual({
      id: "night",
      name: "Night",
      dark: {},
      light: {},
      terminalScheme: "nord",
    });
  });
});

describe("saveErrorKey", () => {
  it("maps the codes to message keys", () => {
    expect(saveErrorKey({ code: "name_taken", detail: "Night" })).toEqual({ key: "settings.appearance.colours.error.taken", vars: { name: "Night" } });
    expect(saveErrorKey({ code: "theme_invalid", detail: "name" }).key).toBe("settings.appearance.colours.error.name");
    expect(saveErrorKey({ code: "theme_invalid", detail: "accent" }).key).toBe("settings.appearance.colours.error.colour");
    expect(saveErrorKey({ code: "io" }).key).toBe("settings.appearance.colours.error.save");
  });
});
