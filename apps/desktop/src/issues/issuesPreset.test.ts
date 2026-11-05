import { expect, it } from "vitest";
import { translate } from "@/i18n";
import { ISSUES_PRESETS, issuesTabVisible, presetStart } from "./issuesPreset";

it("maps each preset to a start", () => {
  expect(presetStart("all")).toEqual({ view: "issues", mine: false, chip: "open" });
  expect(presetStart("issues")).toEqual({ view: "issues", mine: false, chip: "open" });
  expect(presetStart("my_issues")).toEqual({ view: "issues", mine: true, chip: "open" });
  expect(presetStart("prs")).toEqual({ view: "prs", mine: false, chip: "open" });
  expect(presetStart("my_prs")).toEqual({ view: "prs", mine: false, chip: "mine" });
  expect(presetStart("review")).toEqual({ view: "prs", mine: false, chip: "review" });
});

it("has a label for every preset in both languages", () => {
  for (const preset of ISSUES_PRESETS) {
    for (const locale of ["en", "vi"] as const) {
      const key = `settings.git.issuesView.${preset}`;
      expect(translate(locale, key)).not.toBe(key);
    }
  }
});

it("hides the tab only when the setting is off, nothing pinned it and it is not open", () => {
  expect(issuesTabVisible(true, false, false)).toBe(true);
  expect(issuesTabVisible(false, false, false)).toBe(false);
  expect(issuesTabVisible(false, true, false)).toBe(true);
  expect(issuesTabVisible(false, false, true)).toBe(true);
});
