import { describe, expect, it } from "vitest";
import type { ImportPreview } from "@/api";
import { applicable, defaultChosen, fileName, nothingToImport, toggle } from "./configSections";

const section = (name: string, changes: number, invalid = false) => ({
  section: name,
  changes: Array.from({ length: changes }, (_, i) => ({ path: `k${i}`, from: "a", to: "b" })),
  unknown: [],
  secretsRemoved: 0,
  invalid,
});
const preview: ImportPreview = {
  exported: "t",
  sections: [section("network", 2), section("terminal", 0), section("git", 1, true), section("editor", 1)],
  unknownSections: [],
};

describe("config import selection", () => {
  it("applies only valid sections that change something", () => {
    expect(preview.sections.map(applicable)).toEqual([true, false, false, true]);
    expect(defaultChosen(preview)).toEqual(["network", "editor"]);
  });
  it("toggles in preview order and never adds an inapplicable section", () => {
    expect(toggle(preview, ["network", "editor"], "network")).toEqual(["editor"]);
    expect(toggle(preview, ["editor"], "network")).toEqual(["network", "editor"]);
    expect(toggle(preview, [], "git")).toEqual([]);
  });
  it("knows when nothing would change", () => {
    expect(nothingToImport(preview)).toBe(false);
    expect(nothingToImport({ ...preview, sections: [section("terminal", 0)] })).toBe(true);
    expect(nothingToImport({ ...preview, sections: [] })).toBe(true);
  });
  it("names a file from either path style", () => {
    expect(fileName("/a/b/x.json")).toBe("x.json");
    expect(fileName("C:\\a\\x.json")).toBe("x.json");
  });
});
