import { describe, expect, it } from "vitest";
import type { PromptTemplate } from "@/api";
import { tokenAtCursor } from "@/agentLaunch/completion";
import { applyMention, finalPrompt, mentionsFor, newTemplateId } from "./mentions";

const insert: PromptTemplate = { id: "a", name: "Review", body: "Review this change.", mode: "insert" };
const append: PromptTemplate = { id: "b", name: "Tests", body: "Run the tests.", mode: "append" };
const lists = {
  tabs: [{ id: "t1", label: "api server", worktree: "/repo/wt/api" }],
  templates: [insert, append],
  files: ["src/review.ts", "README.md"],
  skills: [{ name: "review", description: "Reviews" }],
};

describe("mentionsFor", () => {
  it("lists tabs, then templates, then files for @", () => {
    const token = tokenAtCursor("see @re", 7)!;
    expect(mentionsFor(token, lists).map((m) => m.key)).toEqual(["t:t1", "p:a", "f:README.md", "f:src/review.ts"]);
    const all = tokenAtCursor("@", 1);
    expect(mentionsFor(all!, lists)).toHaveLength(5);
    const api = tokenAtCursor("@api", 4)!;
    expect(mentionsFor(api, lists)[0]).toMatchObject({ kind: "tab", worktree: "/repo/wt/api" });
  });

  it("lists skills for /", () => {
    const token = tokenAtCursor("/rev", 4)!;
    expect(mentionsFor(token, lists).map((m) => m.key)).toEqual(["s:review"]);
  });
});

describe("applyMention", () => {
  it("puts a tab's worktree path in place of the token", () => {
    const text = "look at @api now";
    const token = tokenAtCursor(text, 12)!;
    const done = applyMention(text, token, { kind: "tab", key: "t:t1", label: "api", worktree: "/repo/wt/api" });
    expect(done.text).toBe("look at /repo/wt/api  now");
    expect(done.append).toBeNull();
  });

  it("inserts an insert template and keeps an append one for the send", () => {
    const token = tokenAtCursor("x @Rev", 6)!;
    expect(applyMention("x @Rev", token, { kind: "template", key: "p:a", label: "Review", template: insert }).text).toBe("x Review this change.");
    const kept = applyMention("x @Tes", tokenAtCursor("x @Tes", 6)!, { kind: "template", key: "p:b", label: "Tests", template: append });
    expect(kept).toEqual({ text: "x ", cursor: 2, append });
  });

  it("completes a file as @path", () => {
    const token = tokenAtCursor("@READ", 5)!;
    expect(applyMention("@READ", token, { kind: "file", key: "f:README.md", label: "README.md" }).text).toBe("@README.md ");
  });
});

it("finalPrompt adds the append templates a blank line apart", () => {
  expect(finalPrompt("Fix it.  ", [append])).toBe("Fix it.\n\nRun the tests.");
  expect(finalPrompt("", [append])).toBe("Run the tests.");
});

it("newTemplateId is a valid id", () => {
  expect(newTemplateId(1_700_000_000_000, 0.5)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
});
