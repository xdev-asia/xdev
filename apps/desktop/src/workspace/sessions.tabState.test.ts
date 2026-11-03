import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { leaves, paneOf, splitPane, removeTab } from "./paneTree";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";

const ids = (s: Sessions, w = A) => s.tabs(w).map((t) => t.id);
const leafTabs = (s: Sessions, w = A) => leaves(s.layout(w)!).map((n) => (n.kind === "leaf" ? n.tabs : []));

describe("Sessions tab state", () => {
  let sessions: Sessions | null = null;
  const make = () => (sessions = new Sessions(createMockApi({})));
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  it("new tabs are unpinned and have no colour", () => {
    const s = make();
    expect(s.open(A, "shell")).toMatchObject({ pinned: false, color: "none" });
  });

  it("pinning moves the tab first, in the worktree list and its pane strip, keeping the pinned order", () => {
    const s = make();
    const [a, b, c, d] = [s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell")];
    s.setPinned(c.id, true);
    expect(ids(s)).toEqual([c.id, a.id, b.id, d.id]);
    s.setPinned(d.id, true);
    expect(ids(s)).toEqual([c.id, d.id, a.id, b.id]);
    expect(leafTabs(s)).toEqual([[c.id, d.id, a.id, b.id]]);
    s.setPinned(c.id, false);
    expect(ids(s)).toEqual([d.id, a.id, b.id, c.id]);
    expect(s.tabs(A).find((t) => t.id === d.id)?.pinned).toBe(true);
  });

  it("setColor sets one of the ten tokens and ignores anything else", () => {
    const s = make();
    const a = s.open(A, "shell");
    s.setColor(a.id, "c7");
    expect(s.tabs(A)[0].color).toBe("c7");
    s.setColor(a.id, "red" as never);
    expect(s.tabs(A)[0].color).toBe("c7");
    s.setColor(a.id, "none");
    expect(s.tabs(A)[0].color).toBe("none");
  });

  it("setTitle names the tab by hand; null gives back the program's last title", () => {
    const s = make();
    const a = s.open(A, "shell");
    s.noteTitle(a.id, "vim");
    s.setTitle(a.id, "Editor");
    s.noteTitle(a.id, "htop");
    expect(s.tabs(A)[0]).toMatchObject({ title: "Editor", renamed: true });
    s.setTitle(a.id, null);
    expect(s.tabs(A)[0]).toMatchObject({ title: "htop", renamed: false });
    s.noteTitle(a.id, "less");
    expect(s.tabs(A)[0].title).toBe("less");
  });

  it("an empty title resets like null, and a tab that never had a program title goes back to none", () => {
    const s = make();
    const a = s.open(A, "shell");
    s.setTitle(a.id, "Mine");
    s.setTitle(a.id, "   ");
    expect(s.tabs(A)[0]).toMatchObject({ title: null, renamed: false });
  });

  it("rename stays an alias of setTitle", () => {
    const s = make();
    const a = s.open(A, "shell");
    s.noteTitle(a.id, "zsh");
    s.rename(a.id, "Build");
    expect(s.tabs(A)[0]).toMatchObject({ title: "Build", renamed: true });
    s.setTitle(a.id, null);
    expect(s.tabs(A)[0].title).toBe("zsh");
  });

  it("Close Others keeps pinned tabs and the target, in the target's pane only", async () => {
    const s = make();
    const [a, b, c, d] = [s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell")];
    const other = s.open(B, "shell");
    s.setPinned(b.id, true);
    const kill = vi.spyOn(a.client, "dispose");
    s.closeOthers(c.id);
    expect(ids(s)).toEqual([b.id, c.id]);
    expect(kill).toHaveBeenCalled();
    expect(ids(s, B)).toEqual([other.id]);
    expect(s.tabs(A).some((t) => t.id === d.id)).toBe(false);
  });

  it("Close Others leaves tabs of another pane alone", () => {
    const s = make();
    const [a, b, c] = [s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell")];
    const l = s.layout(A)!;
    s.setLayout(A, splitPane(removeTab(l, c.id)!, paneOf(l, a.id)!, "right", c.id));
    s.closeOthers(a.id);
    expect(ids(s)).toEqual([a.id, c.id]);
    expect(s.tabs(A).some((t) => t.id === b.id)).toBe(false);
  });

  it("Close to the Right closes the later unpinned tabs of the strip", () => {
    const s = make();
    const [a, b, c, d] = [s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell")];
    s.setPinned(d.id, true); // strip: d a b c
    s.closeToRight(a.id);
    expect(ids(s)).toEqual([d.id, a.id]);
    expect(s.tabs(A).some((t) => t.id === b.id || t.id === c.id)).toBe(false);
  });

  it("moveToSplit puts the tab alone in a new pane beside its own, focused", () => {
    const s = make();
    const [a, b, c] = [s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell")];
    expect(s.canMoveToSplit(b.id)).toBe(true);
    s.moveToSplit(b.id, "down");
    const l = s.layout(A)!;
    expect(leafTabs(s)).toEqual([[a.id, c.id], [b.id]]);
    expect(l.root.kind === "split" && l.root.dir).toBe("down");
    expect(l.focused).toBe(paneOf(l, b.id));
    const fresh = leaves(l).find((n) => n.id === l.focused);
    expect(fresh?.kind === "leaf" && fresh.active).toBe(b.id);
  });

  it("a tab alone in its pane cannot move to a split", () => {
    const s = make();
    const a = s.open(A, "shell");
    const before = s.layout(A);
    const heard = vi.fn();
    s.subscribe(heard);
    expect(s.canMoveToSplit(a.id)).toBe(false);
    s.moveToSplit(a.id, "right");
    expect(s.layout(A)).toBe(before);
    expect(heard).not.toHaveBeenCalled();
    expect(s.canMoveToSplit("nope")).toBe(false);
  });

  it("subscribe fires once per change and not for a change to the same value", () => {
    const s = make();
    const [a, b, c] = [s.open(A, "shell"), s.open(A, "shell"), s.open(A, "shell")];
    const heard = vi.fn();
    s.subscribe(heard);
    s.setPinned(a.id, true);
    expect(heard).toHaveBeenCalledTimes(1);
    s.setPinned(a.id, true);
    s.setColor(a.id, "none");
    s.setTitle(a.id, null);
    expect(heard).toHaveBeenCalledTimes(1);
    s.setColor(a.id, "c2");
    expect(heard).toHaveBeenCalledTimes(2);
    s.setTitle(a.id, "T");
    expect(heard).toHaveBeenCalledTimes(3);
    s.moveToSplit(b.id, "right");
    expect(heard).toHaveBeenCalledTimes(4);
    s.closeOthers(a.id);
    expect(heard).toHaveBeenCalledTimes(5);
    void c;
  });

  it("a restarted tab keeps its pin and colour", () => {
    const s = make();
    const a = s.open(A, "shell");
    s.open(A, "shell");
    s.setPinned(a.id, true);
    s.setColor(a.id, "c3");
    const next = s.restart(a.id)!;
    expect(s.tabs(A)[0]).toMatchObject({ id: next.id, pinned: true, color: "c3" });
  });

  it("unknown ids do nothing", () => {
    const s = make();
    s.open(A, "shell");
    const heard = vi.fn();
    s.subscribe(heard);
    s.setPinned("x", true);
    s.setColor("x", "c1");
    s.setTitle("x", "t");
    s.moveToSplit("x", "right");
    s.closeOthers("x");
    s.closeToRight("x");
    expect(heard).not.toHaveBeenCalled();
  });
});
