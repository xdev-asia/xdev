import { expect, it } from "vitest";
import type { ReviewFile } from "@/api";
import { postBlock } from "./postable";

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, kind: "modified", staged: false, unstaged: false, ...over });
const note = { file: "a.ts" };

it("postBlock: a note goes when HEAD is the PR head and its file is committed", () => {
  expect(postBlock(note, { headOid: "abc", files: [file("a.ts"), file("b.ts", { unstaged: true })] }, "abc")).toBeNull();
});

it("postBlock: another HEAD means the PR lacks the lines", () => {
  expect(postBlock(note, { headOid: "def", files: [file("a.ts")] }, "abc")).toBe("push");
  expect(postBlock(note, { headOid: null, files: [] }, "abc")).toBe("push");
});

it("postBlock: an uncommitted change in the note's file blocks it, staged or not", () => {
  expect(postBlock(note, { headOid: "abc", files: [file("a.ts", { staged: true })] }, "abc")).toBe("push");
  expect(postBlock(note, { headOid: "abc", files: [file("a.ts", { unstaged: true })] }, "abc")).toBe("push");
});

it("postBlock: an unread PR head or review blocks it as unknown", () => {
  expect(postBlock(note, { headOid: "abc", files: [] }, null)).toBe("unknown");
  expect(postBlock(note, null, "abc")).toBe("unknown");
});
