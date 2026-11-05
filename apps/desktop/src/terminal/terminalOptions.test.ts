import { expect, it } from "vitest";
import { TERMINAL_DEFAULTS } from "./terminalSettings";
import { xtermOptions } from "./terminalOptions";
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
