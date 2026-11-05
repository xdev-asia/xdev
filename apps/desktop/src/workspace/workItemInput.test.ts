import { describe, expect, it } from "vitest";
import { itemKindOf, parseItem } from "./workItemInput";

describe("itemKindOf", () => {
  it("reads a pull request and an issue link, nothing else", () => {
    expect(itemKindOf("https://github.com/acme/app/pull/12")).toBe("pr");
    expect(itemKindOf(" https://github.com/acme/app/pull/12/files ")).toBe("pr");
    expect(itemKindOf("https://github.com/acme/app/issues/3")).toBe("issue");
    expect(itemKindOf("https://github.com/acme/app/issues/3?x=1#c")).toBe("issue");
    expect(itemKindOf("https://github.com/acme/app")).toBeNull();
    expect(itemKindOf("https://github.com/acme/app/pulls")).toBeNull();
    expect(itemKindOf("https://example.com/a/pull/x")).toBeNull();
    expect(itemKindOf("not a link")).toBeNull();
    expect(itemKindOf("")).toBeNull();
  });
});

describe("parseItem", () => {
  it("keeps the typed kind for a web link and refuses others", () => {
    expect(parseItem("", "pr")).toBeNull();
    expect(parseItem("https://x.dev/1", "issue")).toEqual({ kind: "issue", url: "https://x.dev/1", title: null });
    expect(parseItem("ftp://x.dev/1", "pr")).toBe("bad");
    expect(parseItem("nope", "pr")).toBe("bad");
  });
});
