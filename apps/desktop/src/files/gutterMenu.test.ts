import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { translate } from "@/i18n";
import { gutterMenuItems, remoteRange, selectionOf, type GutterContext } from "./gutterMenu";

function ctx(over: Partial<GutterContext> = {}) {
  const toasts: string[] = [];
  const copied: string[] = [];
  const c: GutterContext = {
    api: { fileRemoteUrl: vi.fn(async (_w, rel, line, end) => `https://h/${rel}#L${line}${end ? `-L${end}` : ""}`) },
    worktree: "/home/u/wt",
    rel: "src/a.ts",
    line: 12,
    selection: null,
    copyText: async (text) => {
      copied.push(text);
      return true;
    },
    toast: (text) => void toasts.push(text),
    t: (key) => translate("en", key),
    win: false,
    ...over,
  };
  return { c, toasts, copied };
}
const run = async (items: ReturnType<typeof gutterMenuItems>, id: string) => {
  items.find((i) => i.id === id)!.run!();
  await new Promise((r) => setTimeout(r, 0));
};

describe("gutterMenuItems", () => {
  it("lists the three rows in order", () => {
    expect(gutterMenuItems(ctx().c).map((i) => [i.id, i.labelKey])).toEqual([
      ["copyPath", "editor.gutter.copyPath"],
      ["copyRelPath", "editor.gutter.copyRelPath"],
      ["copyRemote", "editor.gutter.copyRemote"],
    ]);
  });

  it("copies the absolute path with the OS's separators and the relative one with /", async () => {
    const posix = ctx();
    await run(gutterMenuItems(posix.c), "copyPath");
    await run(gutterMenuItems(posix.c), "copyRelPath");
    expect(posix.copied).toEqual(["/home/u/wt/src/a.ts:12", "src/a.ts:12"]);
    expect(posix.toasts).toEqual(["Copied", "Copied"]);
    const win = ctx({ worktree: "E:/a", win: true });
    await run(gutterMenuItems(win.c), "copyPath");
    await run(gutterMenuItems(win.c), "copyRelPath");
    expect(win.copied).toEqual(["E:\\a\\src\\a.ts:12", "src/a.ts:12"]);
  });

  it("copies the remote URL of the line, or of the selected lines", async () => {
    const one = ctx();
    await run(gutterMenuItems(one.c), "copyRemote");
    expect(one.c.api.fileRemoteUrl).toHaveBeenCalledWith("/home/u/wt", "src/a.ts", 12, null);
    expect(one.copied).toEqual(["https://h/src/a.ts#L12"]);
    const many = ctx({ selection: { fromLine: 10, toLine: 14, toCol: 3 } });
    await run(gutterMenuItems(many.c), "copyRemote");
    expect(many.c.api.fileRemoteUrl).toHaveBeenCalledWith("/home/u/wt", "src/a.ts", 10, 14);
    expect(many.copied).toEqual(["https://h/src/a.ts#L10-L14"]);
  });

  it("says when there is no remote, and when copying or the lookup fails", async () => {
    const none = ctx({ api: { fileRemoteUrl: () => Promise.reject({ code: "no_web_remote" }) } });
    await run(gutterMenuItems(none.c), "copyRemote");
    expect(none.toasts).toEqual(["No GitHub, GitLab or Bitbucket remote for this file"]);
    const slow = ctx({ api: { fileRemoteUrl: () => Promise.reject({ code: "timeout" }) } });
    await run(gutterMenuItems(slow.c), "copyRemote");
    expect(slow.toasts).toEqual(["Copy failed"]);
    const refused = ctx({ copyText: async () => false });
    await run(gutterMenuItems(refused.c), "copyPath");
    expect(refused.toasts).toEqual(["Copy failed"]);
  });
});

describe("remoteRange", () => {
  const sel = (fromLine: number, toLine: number, toCol: number) => ({ fromLine, toLine, toCol });
  it("names the selection when the click is inside a multi-line one", () => {
    expect(remoteRange(12, sel(10, 14, 5))).toEqual({ line: 10, endLine: 14 });
    expect(remoteRange(10, sel(10, 14, 5))).toEqual({ line: 10, endLine: 14 });
    expect(remoteRange(14, sel(10, 14, 5))).toEqual({ line: 10, endLine: 14 });
  });
  it("names the line for a click outside, or without a selection", () => {
    expect(remoteRange(9, sel(10, 14, 5))).toEqual({ line: 9, endLine: null });
    expect(remoteRange(15, sel(10, 14, 5))).toEqual({ line: 15, endLine: null });
    expect(remoteRange(12, null)).toEqual({ line: 12, endLine: null });
  });
  it("ends one line earlier when the selection ends at column 1", () => {
    expect(remoteRange(11, sel(10, 14, 1))).toEqual({ line: 10, endLine: 13 });
    expect(remoteRange(14, sel(10, 14, 1))).toEqual({ line: 14, endLine: null });
    // Selecting a whole line by its end-of-line break is that one line.
    expect(remoteRange(10, sel(10, 11, 1))).toEqual({ line: 10, endLine: null });
  });
});

describe("selectionOf", () => {
  const state = (anchor: number, head: number) =>
    EditorState.create({ doc: "ab\ncd\nef\n", selection: EditorSelection.single(anchor, head) });
  it("reads a multi-line selection with the column of its end", () => {
    expect(selectionOf(state(1, 7))).toEqual({ fromLine: 1, toLine: 3, toCol: 2 });
    expect(selectionOf(state(7, 1))).toEqual({ fromLine: 1, toLine: 3, toCol: 2 });
    expect(selectionOf(state(0, 6))).toEqual({ fromLine: 1, toLine: 3, toCol: 1 });
  });
  it("is null for a caret and for a selection inside one line", () => {
    expect(selectionOf(state(4, 4))).toBeNull();
    expect(selectionOf(state(3, 5))).toBeNull();
  });
});
