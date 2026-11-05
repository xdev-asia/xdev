import { expect, it } from "vitest";
import { completionKey, insertCompletion, MAX_SHOWN, rankMatches, tokenAtCursor } from "./completion";

it("finds a token that starts the text or follows whitespace", () => {
  expect(tokenAtCursor("/rev", 4)).toEqual({ trigger: "/", query: "rev", start: 0, end: 4 });
  expect(tokenAtCursor("see @src/ap", 11)).toEqual({ trigger: "@", query: "src/ap", start: 4, end: 11 });
  expect(tokenAtCursor("a\n/x", 4)?.start).toBe(2);
});

it("finds no token inside a word, on a bare trigger-less word or right before the trigger", () => {
  expect(tokenAtCursor("a/b", 3)).toBeNull();
  expect(tokenAtCursor("me@host", 7)).toBeNull();
  expect(tokenAtCursor("plain", 5)).toBeNull();
  expect(tokenAtCursor("/x", 0)).toBeNull();
  expect(tokenAtCursor("/x", 9)).toBeNull();
});

it("a bare trigger is a token with an empty query", () => {
  expect(tokenAtCursor("go @", 4)).toEqual({ trigger: "@", query: "", start: 3, end: 4 });
});

it("the token runs to the end of the word past the cursor", () => {
  expect(tokenAtCursor("/revxx tail", 4)).toEqual({ trigger: "/", query: "rev", start: 0, end: 6 });
});

it("ranks a file-name prefix, then a path prefix, then substrings, then letters in order", () => {
  const files = ["docs/readme.md", "src/app.ts", "app/main.ts", "src/lib/apple.ts", "a/p/p"];
  expect(rankMatches(files, "app")).toEqual(["src/app.ts", "src/lib/apple.ts", "app/main.ts", "a/p/p"]);
  expect(rankMatches(files, "")).toHaveLength(5);
  expect(rankMatches(files, "zzz")).toEqual([]);
  expect(rankMatches(["Review"], "REV")).toEqual(["Review"]);
});

it("shows at most 50", () => {
  const many = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
  expect(rankMatches(many, "f")).toHaveLength(MAX_SHOWN);
  expect(rankMatches(many, "f", 3)).toHaveLength(3);
});

it("inserts the name or path and a space, and moves the cursor after it", () => {
  const token = tokenAtCursor("run /re now", 7)!;
  expect(insertCompletion("run /re now", token, "review")).toEqual({ text: "run /review now", cursor: 12 });
  const file = tokenAtCursor("read @sr", 8)!;
  expect(insertCompletion("read @sr", file, "src/app.ts")).toEqual({ text: "read @src/app.ts ", cursor: 17 });
});

it("keys move through the list with wrapping, accept with Enter or Tab and close with Escape", () => {
  expect(completionKey("ArrowDown", 2, 3)).toEqual({ index: 0, action: "none" });
  expect(completionKey("ArrowUp", 0, 3)).toEqual({ index: 2, action: "none" });
  expect(completionKey("Enter", 1, 3)).toEqual({ index: 1, action: "accept" });
  expect(completionKey("Tab", 1, 3)).toEqual({ index: 1, action: "accept" });
  expect(completionKey("Escape", 1, 3)).toEqual({ index: 1, action: "close" });
  expect(completionKey("a", 1, 3)).toBeNull();
});

it("with no match only Escape is handled, so Enter and Tab keep their own meaning", () => {
  expect(completionKey("Enter", 0, 0)).toBeNull();
  expect(completionKey("Tab", 0, 0)).toBeNull();
  expect(completionKey("Escape", 0, 0)).toEqual({ index: 0, action: "close" });
});
