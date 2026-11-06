import { describe, expect, it } from "vitest";
import { dirInside } from "./shellDir";

describe("dirInside", () => {
  it("gives the folder relative to the worktree, empty for the worktree itself", () => {
    expect(dirInside("/w/one", "/w/one")).toBe("");
    expect(dirInside("/w/one/", "/w/one/src/lib")).toBe("src/lib");
    expect(dirInside("/w/one", "/w/one/src/../docs/.")).toBe("docs");
  });

  it("is null outside the worktree", () => {
    for (const out of ["/w/one/..", "/w/other", "/w/one-two", "/w/one/../two/x", "/w", "/.."]) {
      expect(dirInside("/w/one", out), out).toBeNull();
    }
  });

  it("takes either slash and ignores case after a drive letter", () => {
    expect(dirInside("C:\\Code\\one", "c:/code/one/src")).toBe("src");
    expect(dirInside("C:/Code/one", "D:/Code/one/src")).toBeNull();
    // Without a drive letter the case counts.
    expect(dirInside("/w/One", "/w/one/src")).toBeNull();
  });
});
