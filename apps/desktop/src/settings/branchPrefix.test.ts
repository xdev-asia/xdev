import { describe, expect, it } from "vitest";
import { normalizePrefix, prefixIssue, previewPrefix } from "./branchPrefix";

// The same cases as `names.rs`, so the two sides cannot drift apart unnoticed.
describe("normalizePrefix", () => {
  it("trims and tidies slashes", () => {
    expect(normalizePrefix("  feature  ")).toBe("feature");
    expect(normalizePrefix("/team//me/")).toBe("team/me");
    expect(normalizePrefix("a///b")).toBe("a/b");
    expect(normalizePrefix(" // ")).toBe("");
    expect(normalizePrefix("")).toBe("");
  });
});

describe("prefixIssue", () => {
  it("accepts what git accepts", () => {
    for (const ok of ["feature", "team/me", "duy.tran", "a-b_c", "Tên"]) expect(prefixIssue(ok)).toBeNull();
  });

  it("follows git ref rules, in the Rust order", () => {
    const bad: [string, string][] = [
      ["a b", "control"],
      ["a\tb", "control"],
      ["a\u007f", "control"],
      ["a~b", "char"],
      ["a^b", "char"],
      ["a:b", "char"],
      ["a?b", "char"],
      ["a*b", "char"],
      ["a[b", "char"],
      ["a\\b", "char"],
      ["a..b", "sequence"],
      ["a@{b", "sequence"],
      ["-a", "edge"],
      ["a.", "edge"],
      [".a", "part"],
      ["a/.b", "part"],
      ["a.lock/b", "part"],
      ["a/b.lock", "part"],
    ];
    for (const [input, want] of bad) expect(prefixIssue(input), input).toBe(want);
  });
});

describe("previewPrefix", () => {
  it("uses the mode's source and normalizes it", () => {
    expect(previewPrefix({ branchPrefix: "custom", branchPrefixCustom: " /team//me/ " }, "duy")).toEqual({ kind: "prefix", prefix: "team/me" });
    expect(previewPrefix({ branchPrefix: "git-username", branchPrefixCustom: "team" }, "duy")).toEqual({ kind: "prefix", prefix: "duy" });
    expect(previewPrefix({ branchPrefix: "none", branchPrefixCustom: "team" }, "duy")).toEqual({ kind: "none" });
  });

  it("adds nothing for a blank custom prefix or a missing username", () => {
    expect(previewPrefix({ branchPrefix: "custom", branchPrefixCustom: " / " }, "duy")).toEqual({ kind: "none" });
    expect(previewPrefix({ branchPrefix: "git-username", branchPrefixCustom: "" }, null)).toEqual({ kind: "none" });
  });

  it("refuses a bad custom prefix but skips a bad username silently", () => {
    expect(previewPrefix({ branchPrefix: "custom", branchPrefixCustom: "a b" }, null)).toEqual({ kind: "invalid", issue: "control" });
    expect(previewPrefix({ branchPrefix: "git-username", branchPrefixCustom: "" }, "Duy Tran")).toEqual({ kind: "none" });
  });
});
