import { expect, it } from "vitest";
import { translate } from "@/i18n";
import { OPTION_MODES, optionStateText } from "./TerminalKeyboardSection";

it("the five modes are the stored values, in order", () => {
  expect(OPTION_MODES).toEqual(["auto", "both", "left", "right", "off"]);
});

it("auto names the detected layout, any other mode its own line", () => {
  expect(optionStateText("auto", "us")).toEqual({ key: "settings.terminal.keyboard.state.auto", layoutKey: "settings.terminal.keyboard.layout.us" });
  expect(optionStateText("auto", "unknown").layoutKey).toBe("settings.terminal.keyboard.layout.unknown");
  expect(optionStateText("left", "other")).toEqual({ key: "settings.terminal.keyboard.state.left" });
});

it("every key it can name exists in en and vi", () => {
  for (const lang of ["en", "vi"] as const) {
    for (const mode of OPTION_MODES) for (const layout of ["us", "other", "unknown"] as const) {
      const { key, layoutKey } = optionStateText(mode, layout);
      expect(translate(lang, key, { layout: "x" })).not.toBe(key);
      if (layoutKey) expect(translate(lang, layoutKey)).not.toBe(layoutKey);
    }
    for (const m of OPTION_MODES) expect(translate(lang, `settings.terminal.keyboard.mode.${m}`)).not.toBe(`settings.terminal.keyboard.mode.${m}`);
  }
});
