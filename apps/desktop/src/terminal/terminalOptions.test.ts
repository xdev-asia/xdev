import { expect, it } from "vitest";
import { TERMINAL_DEFAULTS } from "./terminalSettings";
import { withAlpha, xtermOptions } from "./terminalOptions";
import { TERMINAL_SCHEMES } from "./terminalThemes";

const token = (name: string) => ({ "--x-color-surface": "#101010", "--x-color-ink": "#eeeeee" })[name];

it("passes the interaction options through", () => {
  const o = xtermOptions(
    { ...TERMINAL_DEFAULTS, wordSeparators: " /", scrollSensitivity: 2, fastScrollSensitivity: 8, minimumContrast: 4.5 },
    "mono",
    token,
  );
  expect(o).toMatchObject({ wordSeparator: " /", scrollSensitivity: 2, fastScrollSensitivity: 8, minimumContrastRatio: 4.5 });
});

it("the default theme is the token look; a scheme id gives its colours", () => {
  expect(xtermOptions(TERMINAL_DEFAULTS, "mono", token).theme).toEqual({ background: "#101010", foreground: "#eeeeee" });
  const nord = xtermOptions({ ...TERMINAL_DEFAULTS, theme: "nord" }, "mono", token).theme;
  expect(nord?.background).toMatch(/^#[0-9a-f]{6}$/);
  expect(nord?.background).not.toBe("#101010");
});

it("keeps the font options as before", () => {
  const o = xtermOptions({ ...TERMINAL_DEFAULTS, fontFamily: "  ", fontWeight: "medium" }, undefined, token);
  expect(o).toMatchObject({ fontFamily: "monospace", fontWeight: "500" });
});

it("takes a custom scheme from the list it is given", () => {
  const colors = { ...TERMINAL_SCHEMES[0].colors, background: "#123456" };
  const custom = [{ id: "custom-mine", name: "Mine", mode: "dark" as const, colors }];
  expect(xtermOptions({ ...TERMINAL_DEFAULTS, theme: "custom-mine" }, "mono", token, custom).theme).toEqual(colors);
});

it("light mode uses the light theme only when a separate one is on", () => {
  const s = { ...TERMINAL_DEFAULTS, theme: "nord", themeLight: "one-light" };
  const one = TERMINAL_SCHEMES.find((x) => x.id === "one-light")!;
  const nord = TERMINAL_SCHEMES.find((x) => x.id === "nord")!;
  expect(xtermOptions(s, "mono", token, [], true).theme).toEqual(nord.colors);
  expect(xtermOptions({ ...s, themeFollowApp: true }, "mono", token, [], true).theme).toEqual(one.colors);
  expect(xtermOptions({ ...s, themeFollowApp: true }, "mono", token, [], false).theme).toEqual(nord.colors);
});

it("the new text and transparency options reach xterm", () => {
  const o = xtermOptions({ ...TERMINAL_DEFAULTS, fontWeightBold: "600", scrollOnInput: false }, "mono", token);
  expect(o).toMatchObject({ fontWeightBold: "600", scrollOnUserInput: false, allowTransparency: false });
});

it("opacity below 1 turns transparency on and puts an alpha byte on a hex background", () => {
  const o = xtermOptions({ ...TERMINAL_DEFAULTS, theme: "nord", backgroundOpacity: 0.5 }, "mono", token);
  expect(o.allowTransparency).toBe(true);
  expect(o.theme.background).toMatch(/^#[0-9a-f]{6}80$/);
  expect(xtermOptions({ ...TERMINAL_DEFAULTS, backgroundOpacity: 1 }, "mono", token).theme.background).toBe("#101010");
});

it("withAlpha leaves a non-hex colour and full opacity alone, and expands #rgb", () => {
  expect(withAlpha("rgb(1, 2, 3)", 0.5)).toBe("rgb(1, 2, 3)");
  expect(withAlpha("#102030", 1)).toBe("#102030");
  expect(withAlpha("#abc", 0.5)).toBe("#aabbcc80");
  expect(withAlpha(undefined, 0.5)).toBeUndefined();
});
