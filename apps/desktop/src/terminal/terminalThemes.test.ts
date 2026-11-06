import { expect, it } from "vitest";
import { APP_ANSI_SOURCE, TERMINAL_SCHEMES, terminalTheme, type TerminalPalette } from "./terminalThemes";

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

const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const scheme = (id: string) => TERMINAL_SCHEMES.find((s) => s.id === id)!;

it("app and an unknown id take the token background and foreground with a readable ANSI set per mode", () => {
  for (const [light, source] of [[false, APP_ANSI_SOURCE.dark], [true, APP_ANSI_SOURCE.light]] as const) {
    const src = scheme(source);
    expect(src.mode).toBe(light ? "light" : "dark");
    for (const id of ["app", "no-such-scheme"]) {
      const theme = terminalTheme(id, token, [], light);
      expect(theme.background).toBe("#101010");
      expect(theme.foreground).toBe("#eeeeee");
      for (const key of ANSI_KEYS) expect(theme[key], `${id}.${key}`).toBe(src.colors[key]);
      expect(theme.selectionBackground).toBe(src.colors.selectionBackground);
    }
  }
  // Light and dark differ, so the light tokens never get the pale dark-mode yellow.
  expect(terminalTheme("app", token, [], true).yellow).not.toBe(terminalTheme("app", token, [], false).yellow);
  const bare = terminalTheme("app", () => undefined);
  expect(bare.background).toBeUndefined();
  expect(bare.foreground).toBeUndefined();
  expect(bare.cursor).toBeUndefined();
});

it("the app look takes its cursor from the signal token", () => {
  expect(terminalTheme("app", (n) => (n === "--x-color-signal" ? "#00aaff" : undefined)).cursor).toBe("#00aaff");
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
  expect(terminalTheme("custom-gone", token, custom)).toEqual(terminalTheme("app", token));
  // The bundled schemes win over a custom one with the same id.
  expect(terminalTheme(TERMINAL_SCHEMES[0].id, token, [{ ...custom[0], id: TERMINAL_SCHEMES[0].id }])).toEqual(TERMINAL_SCHEMES[0].colors);
});
