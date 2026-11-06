import { describe, expect, it } from "vitest";
import { createMockAppThemes, parseAppThemeFile } from "./mockAppThemes";

const DUSK = "/home/demo/Dusk.xdev-theme.json";
const input = (name: string) => ({ name, dark: { "text-1": "#fff" }, light: {} });

describe("mock app themes", () => {
  it("saves a new theme with normalised colours", async () => {
    const api = createMockAppThemes();
    const t = await api.appThemeSave(input("Night"));
    expect(t).toMatchObject({ id: "night", name: "Night", dark: { "text-1": "#ffffff" } });
    expect(await api.appThemes()).toHaveLength(1);
  });

  it("refuses a taken name, a bad colour and an empty name", async () => {
    const api = createMockAppThemes();
    await api.appThemeSave(input("Night"));
    await expect(api.appThemeSave(input("night"))).rejects.toMatchObject({ code: "name_taken", detail: "Night" });
    await expect(api.appThemeSave({ ...input("X"), dark: { accent: "red" } })).rejects.toMatchObject({ code: "theme_invalid", detail: "accent" });
    await expect(api.appThemeSave(input("  "))).rejects.toMatchObject({ code: "theme_invalid", detail: "name" });
    await expect(api.appThemeSave({ ...input("Y"), terminalScheme: "Bad Id" })).rejects.toMatchObject({ detail: "terminalScheme" });
  });

  it("renames on save with an id", async () => {
    const api = createMockAppThemes();
    await api.appThemeSave(input("Night"));
    const t = await api.appThemeSave({ ...input("Midnight"), id: "night" });
    expect(t.id).toBe("midnight");
    expect((await api.appThemes()).map((x) => x.id)).toEqual(["midnight"]);
  });

  it("imports the Dusk fixture and handles a clash", async () => {
    const api = createMockAppThemes();
    expect((await api.appThemeImport(DUSK, "fail")).name).toBe("Dusk");
    await expect(api.appThemeImport(DUSK, "fail")).rejects.toMatchObject({ code: "name_taken" });
    expect((await api.appThemeImport(DUSK, "keepBoth")).name).toBe("Dusk 2");
    expect((await api.appThemeImport(DUSK, "replace")).id).toBe("dusk");
    expect(await api.appThemes()).toHaveLength(2);
  });

  it("rejects the broken file and an unknown path", async () => {
    const api = createMockAppThemes();
    await expect(api.appThemeImport("/home/demo/broken.json", "fail")).rejects.toMatchObject({ code: "theme_invalid", detail: "format" });
    await expect(api.appThemeImport("/nope.json", "fail")).rejects.toMatchObject({ code: "not_found" });
    expect(() => parseAppThemeFile("x".repeat(70 * 1024))).toThrowError(expect.objectContaining({ code: "theme_too_large" }));
  });

  it("exports the name of the terminal scheme only", async () => {
    const api = createMockAppThemes();
    await api.appThemeSave({ ...input("Night"), terminalScheme: "nord" });
    expect(await api.appThemeExport("night")).toBe("/home/demo/night.xdev-theme.json");
    const doc = JSON.parse(api.__appThemeExports()[0]!.text);
    expect(doc).toMatchObject({ format: "xdev-app-theme", version: 1, terminalScheme: "nord" });
  });

  it("removes and reports a missing id", async () => {
    const api = createMockAppThemes();
    await api.appThemeSave(input("Night"));
    await api.appThemeRemove("night");
    await expect(api.appThemeRemove("night")).rejects.toMatchObject({ code: "not_found" });
  });
});
