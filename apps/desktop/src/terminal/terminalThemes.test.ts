import { expect, it } from "vitest";
import { TERMINAL_SCHEMES, terminalTheme, type TerminalPalette } from "./terminalThemes";

const token = (name: string) => ({ "--x-color-surface": "#101010", "--x-color-ink": "#eeeeee" })[name];

it("ids are unique and match the rule Rust stores", () => {
  const ids = TERMINAL_SCHEMES.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(id).not.toBe("app");
  }
});

it("every scheme has the full palette, each colour #rrggbb", () => {
  for (const s of TERMINAL_SCHEMES) {
    expect(Object.keys(s.colors), s.id).toHaveLength(21);
    for (const [key, value] of Object.entries(s.colors as TerminalPalette)) {
      expect(value, `${s.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(["dark", "light"]).toContain(s.mode);
    expect(s.name.length).toBeGreaterThan(0);
  }
});

it("has dark and light schemes, and every one names a permissive licence and a source", async () => {
  expect(TERMINAL_SCHEMES.some((s) => s.mode === "dark")).toBe(true);
  expect(TERMINAL_SCHEMES.some((s) => s.mode === "light")).toBe(true);
  const raw = (await import("./terminalThemes.json")).default as { id: string; license: string; source: string }[];
  expect(raw.map((r) => r.id)).toEqual(TERMINAL_SCHEMES.map((s) => s.id));
  for (const r of raw) {
    expect(r.license, r.id).toMatch(/^(MIT|BSD-[23]-Clause|Apache-2\.0|CC0-1\.0)$/);
    expect(r.source, r.id).toMatch(/^https:\/\//);
  }
});

it("app and an unknown id give only the token look", () => {
  const look = { background: "#101010", foreground: "#eeeeee" };
  expect(terminalTheme("app", token)).toEqual(look);
  expect(terminalTheme("no-such-scheme", token)).toEqual(look);
  expect(terminalTheme("app", () => undefined)).toEqual({ background: undefined, foreground: undefined });
});

it("a scheme id gives its palette", () => {
  const s = TERMINAL_SCHEMES[0];
  const theme = terminalTheme(s.id, token);
  expect(theme).toEqual(s.colors);
  expect(theme.background).toBe(s.colors.background);
});

it("a custom id resolves to its colours, and an unknown one still falls back to the app look", () => {
  const colors = { ...TERMINAL_SCHEMES[0].colors, background: "#123456" };
  const custom = [{ id: "custom-mine", name: "Mine", mode: "dark" as const, colors }];
  expect(terminalTheme("custom-mine", token, custom)).toEqual(colors);
  expect(terminalTheme("custom-gone", token, custom)).toEqual({ background: "#101010", foreground: "#eeeeee" });
  // The bundled schemes win over a custom one with the same id.
  expect(terminalTheme(TERMINAL_SCHEMES[0].id, token, [{ ...custom[0], id: TERMINAL_SCHEMES[0].id }])).toEqual(TERMINAL_SCHEMES[0].colors);
});
