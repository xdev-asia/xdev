import { describe, expect, it } from "vitest";
import type { ReviewNote } from "@/api";
import { MAX_ANCHOR, deleteNote, editNote, markSent, newNote, notesPrompt, notesToSend, reanchor } from "./notes";

const make = (over: Partial<ReviewNote> = {}): ReviewNote => ({ ...newNote("a.ts", 3, 3, "target", "fix it", 1, "n1"), ...over });
const text = (...lines: string[]) => lines.join("\n") + "\n";

describe("reanchor", () => {
  it("moves with lines above", () => {
    const r = reanchor([make()], "a.ts", text("new", "new", "x", "y", "target", "z"));
    expect(r.changed).toBe(true);
    expect(r.notes[0]).toMatchObject({ startLine: 5, line: 5, outdated: false });
  });

  it("keeps an unchanged note", () => {
    const notes = [make()];
    const r = reanchor(notes, "a.ts", text("x", "y", "target", "z"));
    expect(r.changed).toBe(false);
    expect(r.notes).toBe(notes);
  });

  it("marks a changed line outdated", () => {
    const r = reanchor([make()], "a.ts", text("x", "y", "rewritten", "z"));
    expect(r.notes[0]).toMatchObject({ startLine: 3, line: 3, outdated: true });
  });

  it("clears outdated when the text comes back", () => {
    const r = reanchor([make({ outdated: true })], "a.ts", text("x", "y", "target"));
    expect(r.changed).toBe(true);
    expect(r.notes[0].outdated).toBe(false);
  });

  it("picks the nearest copy", () => {
    const body = text("target", "a", "b", "c", "target", "d", "e", "target");
    // note was on line 6; copies are on 1, 5 and 8
    const r = reanchor([make({ startLine: 6, line: 6 })], "a.ts", body);
    expect(r.notes[0].startLine).toBe(5);
    // a tie goes to the earlier copy: line 3 is two away from both 1 and 5
    const tie = reanchor([make({ startLine: 3, line: 3 })], "a.ts", body);
    expect(tie.notes[0].startLine).toBe(1);
  });

  it("clamps a note past the end of the file", () => {
    const r = reanchor([make({ startLine: 9, line: 9 })], "a.ts", text("x", "y"));
    expect(r.notes[0]).toMatchObject({ startLine: 2, line: 2, outdated: true });
  });

  it("deleted file", () => {
    const other = make({ id: "n2", file: "b.ts" });
    const r = reanchor([make(), other], "a.ts", null);
    expect(r.notes[0].outdated).toBe(true);
    expect(r.notes[1]).toBe(other);
  });

  it("range", () => {
    const note = newNote("a.ts", 2, 3, "p\nq", "b", 1, "r");
    const r = reanchor([note], "a.ts", text("0", "1", "2", "p", "q", "5"));
    expect(r.notes[0]).toMatchObject({ startLine: 4, line: 5, outdated: false });
    const gone = reanchor([note], "a.ts", text("0", "p", "x"));
    expect(gone.notes[0].outdated).toBe(true);
  });
});

describe("reanchor with CRLF and big ranges", () => {
  it("a CRLF file keeps its notes in place", () => {
    const r = reanchor([make()], "a.ts", "x\r\ny\r\ntarget\r\nz\r\n");
    expect(r.changed).toBe(false);
    const cr = reanchor([make()], "a.ts", "x\ry\rtarget\rz\r");
    expect(cr.changed).toBe(false);
  });

  it("an anchor made from CRLF text is stored with LF", () => {
    expect(newNote("a.ts", 1, 2, "p\r\nq", "b", 1, "i").anchor).toBe("p\nq");
  });

  it("a long range keeps a bounded anchor that still places it", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line number ${i} ${"x".repeat(20)}`);
    const note = newNote("a.ts", 3, 402, lines.join("\n"), "b", 1, "big");
    expect(note.anchor.length).toBeLessThanOrEqual(MAX_ANCHOR);
    const file = ["a", "b", ...lines, "tail"];
    expect(reanchor([note], "a.ts", text(...file)).changed).toBe(false);
    const moved = reanchor([note], "a.ts", text("new", ...file));
    expect(moved.notes[0]).toMatchObject({ startLine: 4, line: 403, outdated: false });
    expect(reanchor([note], "a.ts", text("a", "b", "changed", ...lines.slice(1), "tail")).notes[0].outdated).toBe(true);
  });

  it("one very long line still matches", () => {
    const long = "y".repeat(6000);
    const note = newNote("a.ts", 2, 2, long, "b", 1, "l");
    expect(reanchor([note], "a.ts", text("a", long, "c")).changed).toBe(false);
  });
});

describe("notes", () => {
  it("newNote trims the body and keeps the anchor", () => {
    expect(newNote("a.ts", 2, 4, "x\ny\nz", "  hi \n", 5, "id")).toEqual({
      id: "id",
      file: "a.ts",
      startLine: 2,
      line: 4,
      anchor: "x\ny\nz",
      body: "hi",
      createdAt: 5,
      sentAt: null,
      outdated: false,
    });
    expect(newNote("a.ts", 1, 1, "x", "b", 5).id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("editNote clears sentAt", () => {
    const e = editNote(make({ sentAt: 9 }), " new ");
    expect(e).toMatchObject({ body: "new", sentAt: null });
  });

  it("deletes and marks sent", () => {
    const list = [make(), make({ id: "n2" })];
    expect(deleteNote(list, "n1").map((n) => n.id)).toEqual(["n2"]);
    expect(markSent(list, ["n2"], 7).map((n) => n.sentAt)).toEqual([null, 7]);
  });

  it("notesToSend skips sent unless asked", () => {
    const list = [make({ id: "n2", sentAt: 3, startLine: 8, line: 8 }), make()];
    expect(notesToSend(list, false).map((n) => n.id)).toEqual(["n1"]);
    expect(notesToSend(list, true).map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

describe("notesPrompt", () => {
  const head = "Review notes for feat/x. Fix each point, re-run the tests, then report back:\n\n";

  it("one line", () => {
    expect(notesPrompt("feat/x", [make()])).toBe(`${head}1. a.ts:3 — fix it`);
  });

  it("a range, in file then line order", () => {
    const list = [make({ id: "b", file: "b.ts", body: "late" }), make({ id: "a", startLine: 2, line: 5, body: "range" }), make({ id: "c", body: "one" })];
    expect(notesPrompt("feat/x", list)).toBe(`${head}1. a.ts:2-5 — range\n2. a.ts:3 — one\n3. b.ts:3 — late`);
  });

  it("an outdated note", () => {
    expect(notesPrompt("feat/x", [make({ outdated: true })])).toBe(`${head}1. a.ts:3 — fix it (outdated: the line changed after this note)`);
  });

  it("a multi-line body is indented", () => {
    expect(notesPrompt("feat/x", [make({ body: "first\nsecond\n- third" })])).toBe(`${head}1. a.ts:3 — first\n   second\n   - third`);
  });

  it("a detached HEAD", () => {
    expect(notesPrompt(null, [make()]).startsWith("Review notes for HEAD (detached). ")).toBe(true);
  });
});
