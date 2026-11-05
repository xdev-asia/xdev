import { describe, expect, it } from "vitest";
import { SPARSE_PRESETS_MAX, SPARSE_PRESET_NAME_MAX, addPreset, dedupePresets, presetName, presetText, removePreset } from "./sparsePresets";

const web = { name: "web", dirs: ["apps/web"] };
const docs = { name: "docs", dirs: ["docs", "packages/ui"] };

describe("sparse presets", () => {
  it("dedupes by name, the later one last", () => {
    expect(dedupePresets([web, docs, { name: " web ", dirs: ["crates"] }])).toEqual([docs, { name: "web", dirs: ["crates"] }]);
    expect(dedupePresets([])).toEqual([]);
  });

  it("adds a preset or replaces one of the same name", () => {
    expect(addPreset([web], "docs", docs.dirs)).toEqual([web, docs]);
    expect(addPreset([web, docs], " web", ["crates"])).toEqual([docs, { name: "web", dirs: ["crates"] }]);
  });

  it("refuses a blank or long name, no folders, or one too many", () => {
    expect(addPreset([], "  ", ["a"])).toBe("bad");
    expect(addPreset([], "x".repeat(SPARSE_PRESET_NAME_MAX + 1), ["a"])).toBe("bad");
    expect(addPreset([], "x".repeat(SPARSE_PRESET_NAME_MAX), ["a"])).not.toBe("bad");
    expect(addPreset([], "web", [])).toBe("bad");
    const full = Array.from({ length: SPARSE_PRESETS_MAX }, (_, i) => ({ name: `p${i}`, dirs: ["a"] }));
    expect(addPreset(full, "one more", ["a"])).toBe("bad");
    // Replacing one keeps the count.
    expect(addPreset(full, "p3", ["b"])).toHaveLength(SPARSE_PRESETS_MAX);
  });

  it("removes by name and shows folders one per line", () => {
    expect(removePreset([web, docs], "web")).toEqual([docs]);
    expect(removePreset([web], "nope")).toEqual([web]);
    expect(presetText(docs)).toBe("docs\npackages/ui");
    expect(presetName(" a\tb ")).toBeNull();
    expect(presetName(" ok ")).toBe("ok");
  });
});
