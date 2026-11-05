import { describe, expect, it } from "vitest";
import type { ConflictEntry, ConflictKind } from "@/api";
import en from "@/i18n/en.json";
import vi from "@/i18n/vi.json";
import { conflictHintKey, conflictKindKey, conflictTitleKey, resolutionKey, resolutionsOf } from "./conflictModel";

const entry = (kind: ConflictKind, present = true): ConflictEntry => ({ path: "a.ts", kind, present });
const KINDS: ConflictKind[] = ["both_modified", "both_added", "both_deleted", "added_by_us", "added_by_them", "deleted_by_us", "deleted_by_them"];

describe("conflict rows", () => {
  it("names every kind and gives it a hint, in en and vi", () => {
    for (const kind of KINDS) {
      expect(en, kind).toHaveProperty([conflictKindKey(kind)]);
      expect(vi, kind).toHaveProperty([conflictKindKey(kind)]);
      expect(en, kind).toHaveProperty([conflictHintKey(kind)]);
    }
    expect(conflictKindKey("deleted_by_them")).toBe("conflicts.kind.deleted_by_them");
  });

  it("hints by kind", () => {
    expect(conflictHintKey("both_modified")).toBe("conflicts.hint.markers");
    expect(conflictHintKey("both_added")).toBe("conflicts.hint.choose");
    expect(conflictHintKey("deleted_by_us")).toBe("conflicts.hint.restore");
    expect(conflictHintKey("deleted_by_them")).toBe("conflicts.hint.keepOrDelete");
    expect(conflictHintKey("both_deleted")).toBe("conflicts.hint.keepOrDelete");
    expect(conflictHintKey("added_by_us")).toBe("conflicts.hint.added");
    expect(conflictHintKey("added_by_them")).toBe("conflicts.hint.added");
  });

  it("offers resolutions by rule: no file only deletes, a deletion keeps or deletes, the rest are marked", () => {
    expect(resolutionsOf(entry("both_deleted", false))).toEqual(["keep_deletion"]);
    expect(resolutionsOf(entry("deleted_by_them", false))).toEqual(["keep_deletion"]);
    expect(resolutionsOf(entry("deleted_by_us"))).toEqual(["keep_file", "keep_deletion"]);
    expect(resolutionsOf(entry("deleted_by_them"))).toEqual(["keep_file", "keep_deletion"]);
    for (const kind of ["both_modified", "both_added", "added_by_us", "added_by_them"] as const) expect(resolutionsOf(entry(kind))).toEqual(["mark_resolved"]);
  });

  it("labels each resolution", () => {
    expect(resolutionKey("mark_resolved")).toBe("conflicts.resolve.mark");
    expect(resolutionKey("keep_file")).toBe("conflicts.resolve.keepFile");
    expect(resolutionKey("keep_deletion")).toBe("conflicts.resolve.keepDeletion");
  });

  it("titles the group by operation; cherry-pick and revert are a review", () => {
    expect(conflictTitleKey("merge")).toBe("conflicts.title.merge");
    expect(conflictTitleKey("rebase")).toBe("conflicts.title.rebase");
    expect(conflictTitleKey("cherry-pick")).toBe("conflicts.title.review");
    expect(conflictTitleKey("revert")).toBe("conflicts.title.review");
  });
});
