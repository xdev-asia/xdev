import { describe, expect, it, vi } from "vitest";
import type { FileText } from "@/api";
import { CLOSED_FILES_KEPT, FILE_TAB, fileTabId, fileTabRel, FileTabs, isDirty, isFileTab } from "./fileTabs";
import { onOpenFile, openFile } from "./openFile";
import { clampEditorSettings, EDITOR_DEFAULTS } from "./editorDefaults";

it("names file tabs apart from terminals and the review tab", () => {
  expect(fileTabId("src/a.ts")).toBe(`${FILE_TAB}src/a.ts`);
  expect(isFileTab(fileTabId("a"))).toBe(true);
  expect(isFileTab("review:")).toBe(false);
  expect(isFileTab("t1")).toBe(false);
  expect(fileTabRel(fileTabId("a/b c.md"))).toBe("a/b c.md");
  expect(fileTabRel("t1")).toBeNull();
});

it("hands every open to the listeners until they stop", () => {
  const fn = vi.fn();
  const stop = onOpenFile(fn);
  openFile({ worktree: "/wt/a", rel: "src/a.ts", line: 3 });
  expect(fn).toHaveBeenCalledWith({ worktree: "/wt/a", rel: "src/a.ts", line: 3 });
  stop();
  openFile({ worktree: "/wt/a", rel: "b" });
  expect(fn).toHaveBeenCalledTimes(1);
});

it("clamps editor settings like Rust stores them", () => {
  expect(clampEditorSettings(EDITOR_DEFAULTS)).toEqual(EDITOR_DEFAULTS);
  const wild = clampEditorSettings({ ...EDITOR_DEFAULTS, autosaveMs: 5, fontSize: 99, tabSize: 0 });
  expect(wild).toMatchObject({ autosaveMs: 250, fontSize: 32, tabSize: 1 });
  expect(clampEditorSettings({ ...EDITOR_DEFAULTS, autosaveMs: 99999, tabSize: 2.6 })).toMatchObject({ autosaveMs: 10000, tabSize: 3 });
});

const A = "/wt/a";
const B = "/wt/b";
const text = (t: string, hash = "h1"): FileText => ({ rel: "x", text: t, kind: "text", size: t.length, hash, eol: "lf" });

describe("FileTabs", () => {
  it("opens a file once and keeps the order", () => {
    const s = new FileTabs();
    expect(s.open(A, "a.ts")).toBe(true);
    expect(s.open(A, "b.ts")).toBe(true);
    expect(s.open(A, "a.ts")).toBe(false);
    expect(s.list(A).map((e) => e.rel)).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps worktrees apart", () => {
    const s = new FileTabs();
    s.open(A, "a.ts");
    s.open(B, "a.ts");
    s.close(B, "a.ts");
    expect(s.list(A)).toHaveLength(1);
    expect(s.list(B)).toHaveLength(0);
  });

  it("hands out the same list until something changes", () => {
    const s = new FileTabs();
    s.open(A, "a.ts");
    const first = s.list(A);
    expect(s.list(A)).toBe(first);
    s.edit(A, "a.ts", "x");
    expect(s.list(A)).not.toBe(first);
  });

  it("marks dirty on edit and clean on save, keeping edits made while saving", () => {
    const s = new FileTabs();
    s.open(A, "a.ts");
    s.loaded(A, "a.ts", text("one"));
    expect(isDirty(s.get(A, "a.ts")!)).toBe(false);
    s.edit(A, "a.ts", "two");
    expect(isDirty(s.get(A, "a.ts")!)).toBe(true);
    s.edit(A, "a.ts", "three");
    s.saved(A, "a.ts", "two", "h2");
    expect(s.get(A, "a.ts")).toMatchObject({ hash: "h2", saved: "two", text: "three" });
    expect(isDirty(s.get(A, "a.ts")!)).toBe(true);
  });

  it("passes the line to the view, again on a second open", () => {
    const s = new FileTabs();
    s.open(A, "a.ts", { line: 3, column: 2 });
    const first = s.get(A, "a.ts")!.goto!;
    expect(first).toMatchObject({ line: 3, column: 2 });
    s.open(A, "a.ts", { line: 3 });
    expect(s.get(A, "a.ts")!.goto!.seq).toBeGreaterThan(first.seq);
    s.open(A, "a.ts");
    expect(s.get(A, "a.ts")!.goto).toMatchObject({ line: 3 });
  });

  it("reload drops edits and the conflict", () => {
    const s = new FileTabs();
    s.open(A, "a.ts");
    s.loaded(A, "a.ts", text("one"));
    s.edit(A, "a.ts", "mine");
    s.conflict(A, "a.ts", "disk");
    s.loaded(A, "a.ts", text("theirs", "h3"));
    expect(s.get(A, "a.ts")).toMatchObject({ text: "theirs", conflict: null, hash: "h3" });
  });

  it("follows a rename of a file and of a folder", () => {
    const s = new FileTabs();
    s.open(A, "src/a.ts");
    s.open(A, "src/deep/b.ts");
    s.open(A, "other.ts");
    expect(s.rename(A, "src", "lib")).toEqual([
      { from: "src/a.ts", to: "lib/a.ts" },
      { from: "src/deep/b.ts", to: "lib/deep/b.ts" },
    ]);
    expect(s.list(A).map((e) => e.rel)).toEqual(["lib/a.ts", "lib/deep/b.ts", "other.ts"]);
    expect(s.rename(A, "nope", "x")).toEqual([]);
    expect(s.under(A, "lib").map((e) => e.rel)).toEqual(["lib/a.ts", "lib/deep/b.ts"]);
  });
});

describe("FileTabs external state", () => {
  const ready = () => {
    const s = new FileTabs();
    s.open(A, "a.ts");
    s.loaded(A, "a.ts", text("one"));
    return s;
  };

  it("starts clear and marks a file changed, deleted or renamed", () => {
    const s = ready();
    expect(s.get(A, "a.ts")!.external).toBeNull();
    s.markExternal(A, "a.ts", "changed");
    expect(s.get(A, "a.ts")!.external).toBe("changed");
    s.markExternal(A, "a.ts", "deleted");
    expect(s.get(A, "a.ts")!.external).toBe("deleted");
    s.markExternal(A, "a.ts", "renamed");
    expect(s.get(A, "a.ts")!.external).toBe("renamed");
    s.markExternal(A, "a.ts", null);
    expect(s.get(A, "a.ts")!.external).toBeNull();
  });

  it("changes nothing, and tells nobody, when the mark is the same or the file is not open", () => {
    const s = ready();
    const fn = vi.fn();
    s.subscribe(fn);
    s.markExternal(A, "a.ts", null);
    s.markExternal(A, "nope.ts", "deleted");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a load or a save clears the mark", () => {
    const s = ready();
    s.markExternal(A, "a.ts", "changed");
    s.loaded(A, "a.ts", text("two", "h2"));
    expect(s.get(A, "a.ts")!.external).toBeNull();
    s.markExternal(A, "a.ts", "deleted");
    s.saved(A, "a.ts", "two", "h3");
    expect(s.get(A, "a.ts")!.external).toBeNull();
  });

  it("keepMine clears the mark and the conflict, keeps the edits, and adopts the disk hash", () => {
    const s = ready();
    s.edit(A, "a.ts", "mine");
    s.markExternal(A, "a.ts", "changed");
    s.conflict(A, "a.ts", "disk");
    s.keepMine(A, "a.ts", "disk");
    expect(s.get(A, "a.ts")).toMatchObject({ external: null, conflict: null, text: "mine", saved: "one", hash: "disk" });
  });

  it("restore puts a snapshot back", () => {
    const s = ready();
    s.edit(A, "a.ts", "mine");
    const before = s.get(A, "a.ts")!;
    s.loaded(A, "a.ts", text("disk", "h9"));
    s.restore(A, "a.ts", { text: before.text, saved: before.saved, hash: before.hash, eol: before.eol });
    expect(s.get(A, "a.ts")).toMatchObject({ text: "mine", saved: "one", hash: "h1", external: null });
    expect(isDirty(s.get(A, "a.ts")!)).toBe(true);
  });

  it("a mark follows a rename", () => {
    const s = ready();
    s.markExternal(A, "a.ts", "renamed");
    s.rename(A, "a.ts", "b.ts");
    expect(s.get(A, "b.ts")!.external).toBe("renamed");
  });
});

describe("closed file tabs and pins", () => {
  const wt = "/wt/a";
  function withOpen(...rels: string[]): FileTabs {
    const s = new FileTabs();
    for (const rel of rels) s.open(wt, rel);
    return s;
  }

  it("takes closed tabs back newest first", () => {
    const s = withOpen("a", "b", "c");
    s.closeRemembering(wt, "a");
    s.closeRemembering(wt, "c");
    expect(s.takeClosed(wt)?.rel).toBe("c");
    expect(s.takeClosed(wt)?.rel).toBe("a");
    expect(s.takeClosed(wt)).toBeNull();
    expect(s.list(wt).map((e) => e.rel)).toEqual(["b"]);
  });

  it("a plain close leaves nothing to reopen (a deleted file is no closed tab)", () => {
    const s = withOpen("a");
    s.close(wt, "a");
    expect(s.takeClosed(wt)).toBeNull();
    expect(s.lastClosedAt(wt)).toBeNull();
  });

  it("keeps at most the newest CLOSED_FILES_KEPT", () => {
    const rels = Array.from({ length: CLOSED_FILES_KEPT + 5 }, (_, i) => `f${i}`);
    const s = withOpen(...rels);
    for (const rel of rels) s.closeRemembering(wt, rel);
    expect(s.closedList(wt)).toHaveLength(CLOSED_FILES_KEPT);
    expect(s.closedList(wt)[0].rel).toBe("f5");
    expect(s.takeClosed(wt)?.rel).toBe(rels[rels.length - 1]);
  });

  it("keeps a stack per worktree", () => {
    const s = withOpen("a");
    s.open("/wt/b", "z");
    s.closeRemembering(wt, "a");
    s.closeRemembering("/wt/b", "z");
    expect(s.takeClosed(wt)?.rel).toBe("a");
    expect(s.takeClosed(wt)).toBeNull();
    expect(s.takeClosed("/wt/b")?.rel).toBe("z");
  });

  it("skips a file that is open again and lists a file once", () => {
    const s = withOpen("a", "b");
    s.closeRemembering(wt, "a");
    s.closeRemembering(wt, "b");
    s.open(wt, "b");
    expect(s.takeClosed(wt)?.rel).toBe("a");
    s.open(wt, "a");
    s.closeRemembering(wt, "a");
    s.open(wt, "a");
    s.closeRemembering(wt, "a");
    expect(s.closedList(wt).filter((c) => c.rel === "a")).toHaveLength(1);
  });

  it("remembers the pin and ignores a tab that is not open", () => {
    const s = withOpen("a");
    s.setPinned(wt, "a", true);
    expect(s.get(wt, "a")?.pinned).toBe(true);
    s.closeRemembering(wt, "a");
    s.closeRemembering(wt, "nope");
    expect(s.takeClosed(wt)).toMatchObject({ rel: "a", pinned: true });
    s.open(wt, "a");
    s.setPinned(wt, "a", false);
    expect(s.get(wt, "a")?.pinned).toBeFalsy();
  });

  it("a pin survives a reload", () => {
    const s = withOpen("a");
    s.setPinned(wt, "a", true);
    s.loaded(wt, "a", { kind: "text", text: "x", hash: "h", eol: "lf" } as never);
    expect(s.get(wt, "a")?.pinned).toBe(true);
  });
});
