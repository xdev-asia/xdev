import { describe, expect, it } from "vitest";
import { below, displayPath } from "./kitUi";

describe("displayPath", () => {
  it("drops the verbatim prefix from a drive path", () => {
    expect(displayPath("\\\\?\\C:\\Users\\me\\.claude\\CLAUDE.md")).toBe("C:\\Users\\me\\.claude\\CLAUDE.md");
  });

  it("turns a verbatim UNC path into a plain one", () => {
    expect(displayPath("\\\\?\\UNC\\server\\share\\dir")).toBe("\\\\server\\share\\dir");
  });

  it("leaves other paths alone", () => {
    expect(displayPath("C:\\a\\b")).toBe("C:\\a\\b");
    expect(displayPath("/home/me/.codex")).toBe("/home/me/.codex");
    expect(displayPath("\\\\server\\share")).toBe("\\\\server\\share");
  });
});

describe("below", () => {
  it("matches a verbatim path under a plain root", () => {
    expect(below("C:\\work\\repo", "\\\\?\\C:\\work\\repo\\CLAUDE.md")).toBe("CLAUDE.md");
    expect(below("\\\\?\\C:\\work\\repo", "C:\\work\\repo\\a\\b.md")).toBe("a/b.md");
  });
});
