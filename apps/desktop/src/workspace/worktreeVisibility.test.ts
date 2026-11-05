import { expect, it } from "vitest";
import type { RepoView, SidebarPrefs, WorktreeView } from "@/api";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { NO_DETAILS } from "./worktreeDetails";
import { acknowledgeNew, dedupePaths, hasPath, isWorktreeVisible, newExternal, restoreAll, setWorktreeShown, visibilityKey, visibilityRows } from "./worktreeVisibility";

const P: SidebarPrefs = SIDEBAR_PREFS_DEFAULTS;

function wt(name: string, extra: Partial<WorktreeView> = {}): WorktreeView {
  return { path: `/wt/${name}`, name, branch: name, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS, ...extra };
}

it("keys read separators, trailing slashes and a Windows drive letter as one spelling", () => {
  expect(visibilityKey("C:\\code\\x\\")).toBe("c:/code/x");
  expect(visibilityKey("c:/code/x")).toBe("c:/code/x");
  expect(visibilityKey("/")).toBe("/");
  // Only the drive letter folds; the rest keeps its case.
  expect(visibilityKey("D:/Code/X")).toBe("d:/Code/X");
  expect(visibilityKey("/Code/X")).not.toBe(visibilityKey("/code/x"));
});

it("dedupes paths by key, keeps the first spelling and drops blanks", () => {
  expect(dedupePaths(["C:\\a\\b", "c:/a/b/", "", "  ", "/x", "/x/"])).toEqual(["C:\\a\\b", "/x"]);
  expect(hasPath(["C:\\a"], "c:/a")).toBe(true);
  expect(hasPath(["/a"], "/b")).toBe(false);
});

it("is visible: the primary always, hidden never, outside ones by default and the shown list", () => {
  expect(isWorktreeVisible(wt("m", { primary: true }), false, { ...P, hiddenWorktrees: ["/wt/m"] })).toBe(true);
  expect(isWorktreeVisible(wt("a"), false, P)).toBe(true);
  expect(isWorktreeVisible(wt("a"), false, { ...P, hiddenWorktrees: ["/wt/a"] })).toBe(false);
  expect(isWorktreeVisible(wt("e"), true, P)).toBe(false);
  expect(isWorktreeVisible(wt("e"), true, { ...P, shownWorktrees: ["/wt/e"] })).toBe(true);
  expect(isWorktreeVisible(wt("e"), true, { ...P, externalDefaultHidden: false })).toBe(true);
  expect(isWorktreeVisible(wt("e"), true, { ...P, externalDefaultHidden: false, hiddenWorktrees: ["/wt/e"] })).toBe(false);
  // Hidden wins over shown.
  expect(isWorktreeVisible(wt("e"), true, { ...P, shownWorktrees: ["/wt/e"], hiddenWorktrees: ["/wt/e"] })).toBe(false);
});

it("toggles one worktree and keeps a path in one list only", () => {
  const hidden = setWorktreeShown(P, "/wt/a", false, false);
  expect(hidden.hiddenWorktrees).toEqual(["/wt/a"]);
  expect(setWorktreeShown(hidden, "/wt/a", false, false).hiddenWorktrees).toEqual(["/wt/a"]);
  expect(setWorktreeShown(hidden, "/wt/a", false, true).hiddenWorktrees).toEqual([]);
  const shown = setWorktreeShown(P, "/wt/e", true, true);
  expect(shown.shownWorktrees).toEqual(["/wt/e"]);
  const back = setWorktreeShown(shown, "/wt/e", true, false);
  expect(back.shownWorktrees).toEqual([]);
  expect(back.hiddenWorktrees).toEqual(["/wt/e"]);
  // With outside worktrees shown by default, showing one only clears the hidden mark.
  const open = { ...P, externalDefaultHidden: false, hiddenWorktrees: ["/wt/e"] };
  const out = setWorktreeShown(open, "/wt/e", true, true);
  expect(out.hiddenWorktrees).toEqual([]);
  expect(out.shownWorktrees).toEqual([]);
});

it("restore all clears the hidden list and shows the outside ones", () => {
  const prefs = { ...P, hiddenWorktrees: ["/wt/a", "/wt/e"], shownWorktrees: ["/wt/s"] };
  const out = restoreAll(prefs, ["/wt/e", "/wt/f"]);
  expect(out.hiddenWorktrees).toEqual([]);
  expect(out.shownWorktrees).toEqual(["/wt/s", "/wt/e", "/wt/f"]);
  expect(restoreAll({ ...prefs, externalDefaultHidden: false }, ["/wt/e"]).shownWorktrees).toEqual([]);
});

it("new outside worktrees are those in neither list, and only while they default to hidden", () => {
  const prefs = { ...P, hiddenWorktrees: ["C:\\wt\\old"], shownWorktrees: ["/wt/seen"] };
  expect(newExternal(["c:/wt/old", "/wt/seen", "/wt/new", "/wt/new/"], prefs)).toEqual(["/wt/new"]);
  expect(newExternal(["/wt/new"], { ...prefs, externalDefaultHidden: false })).toEqual([]);
  const acked = acknowledgeNew(prefs, ["/wt/new"]);
  expect(newExternal(["/wt/new"], acked)).toEqual([]);
  expect(acked.hiddenWorktrees).toEqual(["C:\\wt\\old", "/wt/new"]);
});

it("the dialog lists outside worktrees, then the managed ones that are hidden", () => {
  const repo = {
    id: "r",
    shortName: "r",
    worktrees: [wt("main", { primary: true }), wt("h"), wt("k")],
    found: [wt("e1"), wt("e2")],
  } as unknown as RepoView;
  const prefs = { ...P, shownWorktrees: ["/wt/e2"], hiddenWorktrees: ["/wt/h", "/wt/main"] };
  expect(visibilityRows([repo], prefs).map((r) => [r.name, r.external, r.visible])).toEqual([
    ["e1", true, false],
    ["e2", true, true],
    ["h", false, false],
  ]);
});
