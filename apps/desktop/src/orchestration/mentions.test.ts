import { describe, expect, it } from "vitest";
import { applyMention, matchTabs, mentionAt, mentionDone, resolveMention } from "./mentions";

const tabs = [
  { id: "1", title: "Lead" },
  { id: "2", title: "Lead agent" },
  { id: "3", title: "Reviewer" },
  { id: "4", title: "Code review" },
];

describe("mentionAt", () => {
  it("finds an @ at the start or after a space", () => {
    expect(mentionAt("@Re", 3)).toEqual({ start: 0, query: "Re" });
    expect(mentionAt("hi @Lead a", 10)).toEqual({ start: 3, query: "Lead a" });
  });

  it("ignores an @ inside a word or before a line break", () => {
    expect(mentionAt("me@host", 7)).toBeNull();
    expect(mentionAt("@Lead\nmore", 10)).toBeNull();
    expect(mentionAt("no mention", 5)).toBeNull();
  });
});

describe("matchTabs", () => {
  it("lists prefix matches before inner ones, in any case", () => {
    expect(matchTabs(tabs, "rev").map((t) => t.id)).toEqual(["3", "4"]);
    expect(matchTabs(tabs, "").length).toBe(4);
    expect(matchTabs(tabs, "zzz")).toEqual([]);
  });
});

describe("mentionDone", () => {
  it("is done once a whole title is followed by a space", () => {
    expect(mentionDone(tabs, "Reviewer ")).toBe(true);
    expect(mentionDone(tabs, "reviewer ")).toBe(true);
    expect(mentionDone(tabs, "Reviewer")).toBe(false);
    expect(mentionDone(tabs, "Lead a")).toBe(false);
  });
});

describe("applyMention", () => {
  it("replaces the typed query with the full title and a space", () => {
    const m = mentionAt("@rev please", 4)!;
    expect(applyMention("@rev please", 4, m, "Reviewer")).toEqual({ text: "@Reviewer please", caret: 10 });
  });
});

describe("resolveMention", () => {
  it("picks the longest live title at the start and strips it", () => {
    expect(resolveMention("@Lead agent run the tests", tabs)).toEqual({ tab: tabs[1], body: "run the tests" });
    expect(resolveMention("  @lead check this", tabs)).toEqual({ tab: tabs[0], body: "check this" });
  });

  it("needs the title to end at a space or the end", () => {
    expect(resolveMention("@Leader go", tabs)).toBeNull();
    expect(resolveMention("hello @Lead", tabs)).toBeNull();
    expect(resolveMention("@Reviewer", tabs)).toEqual({ tab: tabs[2], body: "" });
  });
});
