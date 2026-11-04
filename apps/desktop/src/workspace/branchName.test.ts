import { describe, expect, it } from "vitest";
import { fromWork } from "./branchName";

// The same cases as `names::from_work` tests in crates/xdev-workspace/src/names.rs.
describe("fromWork", () => {
  it("takes the first four words", () => {
    expect(fromWork("fix the footer usage meter rounding")).toBe("fix-the-footer-usage");
    expect(fromWork("  Add   Login\n page  ")).toBe("add-login-page");
    expect(fromWork("one")).toBe("one");
  });
  it("follows the slug rules", () => {
    expect(fromWork("Fix: the footer's (usage)!")).toBe("fix-the-footers-usage");
    expect(fromWork("add re-try to API")).toBe("add-re-try-to-api");
    const long = fromWork("abcdefghijkl ".repeat(6));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
  });
  it("drops a word with a non-ASCII letter, and empty words", () => {
    expect(fromWork("sửa lỗi footer rounding")).toBe("footer-rounding");
    expect(fromWork("a café b")).toBe("a-b");
    expect(fromWork("日本語 だけ")).toBe("");
    expect(fromWork("日本語 fix 😀 the bug now")).toBe("fix-the-bug-now");
    expect(fromWork("")).toBe("");
    expect(fromWork("  ... --- ")).toBe("");
  });
});
