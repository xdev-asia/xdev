import { expect, it } from "vitest";
import { translate } from "@/i18n";
import { withChord } from "./hint";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("a tooltip carries Ctrl+T on Windows and ⌘T on macOS", () => {
  expect(withChord(t, "New tab", "tab.new", false)).toBe("New tab (Ctrl+T)");
  expect(withChord(t, "New tab", "tab.new", true)).toBe("New tab (⌘T)");
});

it("split and close carry their chords", () => {
  expect(withChord(t, "Split right", "pane.splitRight", false)).toContain("Ctrl+Shift+D");
  expect(withChord(t, "Close", "tab.close", true)).toContain("⌘W");
});
