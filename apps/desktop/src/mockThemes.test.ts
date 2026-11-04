import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import type { ApiError } from "@/api";
import { cleanUiFont, createMockSettings, UI_FONT_MAX, UI_SETTINGS_DEFAULTS } from "./mockSettings";
import { contrastRatio, createMockThemes, parseThemeFile, slugOf } from "./mockThemes";

const GRAPHITE = "/demo/themes/graphite-dark.json";
const PAPER = "/demo/themes/paper-light.json";
const MURKY = "/demo/themes/murky.json";

async function code(p: Promise<unknown>): Promise<ApiError> {
  return p.then(() => Promise.reject(new Error("expected a rejection")), (e: ApiError) => e);
}

it("previews a file: the scheme, ignored keys, contrast and name clash", async () => {
  const themes = createMockThemes();
  const graphite = await themes.terminalThemePreview(GRAPHITE);
  expect(graphite.scheme).toMatchObject({ id: "custom-graphite-dark", name: "Graphite Dark", mode: "dark" });
  expect(graphite).toMatchObject({ ignoredKeys: [], lowContrast: false, nameTaken: false });
  const paper = await themes.terminalThemePreview(PAPER);
  expect(paper.scheme.mode).toBe("light");
  expect(paper.scheme.colors.black).toBe("#000000");
  expect(paper.ignoredKeys).toEqual(["futureKey"]);
  expect((await themes.terminalThemePreview(MURKY)).lowContrast).toBe(true);
});

it("names the field of a bad file and never echoes a path", async () => {
  const themes = createMockThemes();
  expect(await code(themes.terminalThemePreview("/demo/themes/broken.json"))).toEqual({ code: "theme_invalid", detail: "foreground" });
  const missing = await code(themes.terminalThemePreview("/nowhere/secret.json"));
  expect(JSON.stringify(missing)).not.toContain("secret");
  expect(() => parseThemeFile("x".repeat(70 * 1024))).toThrow(expect.objectContaining({ code: "theme_too_large" }));
});

it("import follows the clash mode: fail, replace, keep both", async () => {
  const emit = vi.fn();
  const themes = createMockThemes(undefined, emit);
  const first = await themes.terminalThemeImport(GRAPHITE, "fail");
  expect(first.id).toBe("custom-graphite-dark");
  expect(emit).toHaveBeenLastCalledWith(["terminal"]);
  expect((await themes.terminalThemePreview(GRAPHITE)).nameTaken).toBe(true);
  expect((await code(themes.terminalThemeImport(GRAPHITE, "fail"))).code).toBe("theme_name_taken");
  expect((await themes.terminalThemeImport(GRAPHITE, "replace")).id).toBe(first.id);
  expect((await themes.terminalThemeImport(GRAPHITE, "keepBoth")).id).toBe("custom-graphite-dark-2");
  expect((await themes.terminalThemeImport(GRAPHITE, "keepBoth")).id).toBe("custom-graphite-dark-3");
  expect((await themes.terminalThemes()).map((s) => s.id)).toEqual(["custom-graphite-dark", "custom-graphite-dark-2", "custom-graphite-dark-3"]);
});

it("remove drops an imported scheme and refuses an unknown id", async () => {
  const themes = createMockThemes();
  await themes.terminalThemeImport(PAPER, "fail");
  await themes.terminalThemeRemove("custom-paper-light");
  expect(await themes.terminalThemes()).toEqual([]);
  expect((await code(themes.terminalThemeRemove("custom-paper-light"))).code).toBe("not_found");
});

it("the mock api serves the same themes and a file dialog path", async () => {
  const api = createMockApi({});
  expect(await api.pickFile(["json"])).toBe(api.__paths()[0]);
  await api.terminalThemeImport(GRAPHITE, "fail");
  expect(await api.terminalThemes()).toHaveLength(1);
});

it("slug and contrast follow the Rust rules", () => {
  expect(slugOf("Graphite Dark")).toBe("graphite-dark");
  expect(slugOf("  --A__b!! ")).toBe("a-b");
  expect(slugOf("日本")).toBe("theme");
  expect(slugOf("ab ".repeat(40)).length).toBeLessThanOrEqual(33);
  expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
});

it("the ui font is trimmed, capped and free of control characters, like ui_settings_put", async () => {
  expect(cleanUiFont("  Inter  ")).toBe("Inter");
  expect(cleanUiFont("In\u0000ter\n")).toBe("Inter");
  expect(Array.from(cleanUiFont("a".repeat(300)))).toHaveLength(UI_FONT_MAX);
  const settings = createMockSettings();
  const stored = await settings.uiSettingsPut({ ...UI_SETTINGS_DEFAULTS, uiFont: "  Inter\t", sidebar: "tinted" });
  expect(stored).toMatchObject({ uiFont: "Inter", sidebar: "tinted", editorThemeLight: "app" });
  expect(await settings.uiSettingsGet()).toEqual(stored);
});
