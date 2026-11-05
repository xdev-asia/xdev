import { expect, it } from "vitest";
import type { Note } from "@/api";
import { byteLength, hasText, NOTE_BODY_MAX, pasteNote, searchNotes, snippet, tooLong } from "./noteModel";

const note = (tab: string, body: string, over: Partial<Note> = {}): Note => ({ tab, worktree: "/w/oak", title: "Claude", body, updatedAt: 1, ...over });

it("the bound counts UTF-8 bytes", () => {
  expect(NOTE_BODY_MAX).toBe(65_536);
  expect(tooLong("a".repeat(NOTE_BODY_MAX))).toBe(false);
  expect(tooLong("a".repeat(NOTE_BODY_MAX + 1))).toBe(true);
  expect(byteLength("é")).toBe(2);
  expect(tooLong("é".repeat(NOTE_BODY_MAX / 2 + 1))).toBe(true);
});

it("a note has text only when it holds more than blanks", () => {
  expect(hasText(note("t", "x"))).toBe(true);
  expect(hasText(note("t", " \n\t"))).toBe(false);
  expect(hasText(null)).toBe(false);
});

it("search needs every word in the body, title or worktree, and lists newest first", () => {
  const list = [note("a", "fix the parser", { updatedAt: 1 }), note("b", "write docs", { updatedAt: 3, title: "Codex", worktree: "/w/elm" }), note("c", "parser docs", { updatedAt: 2 })];
  expect(searchNotes(list, "").map((n) => n.tab)).toEqual(["b", "c", "a"]);
  expect(searchNotes(list, "PARSER").map((n) => n.tab)).toEqual(["c", "a"]);
  expect(searchNotes(list, "parser docs").map((n) => n.tab)).toEqual(["c"]);
  expect(searchNotes(list, "codex").map((n) => n.tab)).toEqual(["b"]);
  expect(searchNotes(list, "elm").map((n) => n.tab)).toEqual(["b"]);
  expect(searchNotes(list, "nothing")).toEqual([]);
});

it("the snippet is the first line without Markdown marks, cut", () => {
  expect(snippet("\n\n## Plan\nmore")).toBe("Plan");
  expect(snippet("- [ ] item")).toBe("[ ] item");
  expect(snippet("1. first")).toBe("first");
  expect(snippet("x".repeat(200), 10)).toBe("xxxxxxxxx…");
  expect(snippet("")).toBe("");
});

it("a note types in as one bracketed paste with no Enter and no control characters", () => {
  const out = pasteNote("line one\nline two \u001b[31m\n\n");
  expect(out.startsWith("\u001b[200~")).toBe(true);
  expect(out.endsWith("\u001b[201~")).toBe(true);
  expect(out).not.toContain("\r");
  expect(out).toContain("line one\nline two [31m");
  expect(out.slice(6, -6)).not.toContain("\u001b");
});
