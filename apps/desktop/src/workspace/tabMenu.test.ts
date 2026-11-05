import { expect, it } from "vitest";
import en from "@/i18n/en.json";
import viText from "@/i18n/vi.json";
import type { MenuItem } from "@/ui/ContextMenu";
import type { Tab } from "./sessions";
import {
  cycleSameKind, fileCloseTargets, fileTabMenuItems, tabMenuItems,
  type FileTabInfo, type FileTabMenuContext, type TabMenuContext,
} from "./tabMenu";

const tab = (id: string, over: Partial<Tab> = {}) => ({ id, pinned: false, color: "none", ...over }) as Tab;

function setup(over: Partial<TabMenuContext> = {}, tabs: Tab[] = [tab("a"), tab("b"), tab("c")], at = 1) {
  const calls: string[] = [];
  const ctx: TabMenuContext = {
    tab: tabs[at],
    tabs,
    canMoveToSplit: true,
    split: (d) => void calls.push(`split:${d}`),
    moveToSplit: (d) => void calls.push(`move:${d}`),
    setPinned: (p) => void calls.push(`pin:${p}`),
    copyTabId: () => void calls.push("copyId"),
    changeTitle: () => void calls.push("title"),
    setColor: (c) => void calls.push(`color:${c}`),
    close: () => void calls.push("close"),
    closeOthers: () => void calls.push("others"),
    closeToRight: () => void calls.push("right"),
    ...over,
  };
  const items = tabMenuItems(ctx);
  const find = (id: string) => items.find((i) => i.id === id) as MenuItem;
  return { calls, items, find };
}
const ids = (items: MenuItem[]) => items.map((i) => (i.kind === "separator" ? "-" : i.id));

it("lists the items in SCR-14 order", () => {
  expect(ids(setup().items)).toEqual([
    "splitRight", "splitDown", "moveToSplit", "-",
    "pin", "copyTabId", "-",
    "changeTitle", "color", "-",
    "close", "closeOthers", "closeToRight",
  ]);
  expect(ids(setup().find("moveToSplit").children!)).toEqual(["moveRight", "moveDown"]);
});

it("the pin item toggles its label and its call", () => {
  const free = setup();
  expect(free.find("pin").labelKey).toBe("tabMenu.pin");
  free.find("pin").run!();
  const pinned = setup({}, [tab("a"), tab("b", { pinned: true }), tab("c")]);
  expect(pinned.find("pin").labelKey).toBe("tabMenu.unpin");
  pinned.find("pin").run!();
  expect([...free.calls, ...pinned.calls]).toEqual(["pin:true", "pin:false"]);
});

it("the colour submenu has none and ten swatches, marks the current one and sets it", () => {
  const { find, calls } = setup({}, [tab("a"), tab("b", { color: "c3" }), tab("c")]);
  const colors = find("color").children!;
  expect(colors).toHaveLength(11);
  expect(colors.filter((c) => c.checked).map((c) => c.id)).toEqual(["c3"]);
  expect(colors[0].swatch).toBeUndefined();
  expect(colors[3].swatch).toBe("--x-tab-color-3");
  expect(colors[3].labelKey).toBe("tabMenu.color.c3");
  colors[5].run!();
  expect(calls).toEqual(["color:c5"]);
});

it("Move to Split is disabled for a tab alone in its pane", () => {
  const alone = setup({ canMoveToSplit: false });
  expect(alone.find("moveToSplit").disabled).toBe(true);
  expect(setup().find("moveToSplit").disabled).toBeFalsy();
});

it("each item calls its context method", () => {
  const { calls, find } = setup();
  find("splitRight").run!();
  find("splitDown").run!();
  find("moveToSplit").children![0].run!();
  find("moveToSplit").children![1].run!();
  find("copyTabId").run!();
  find("changeTitle").run!();
  find("close").run!();
  find("closeOthers").run!();
  find("closeToRight").run!();
  expect(calls).toEqual(["split:right", "split:down", "move:right", "move:down", "copyId", "title", "close", "others", "right"]);
});

it("Close Others and Close to the Right are disabled when pinned or missing tabs leave nothing to close", () => {
  const only = setup({}, [tab("a")], 0);
  expect(only.find("closeOthers").disabled).toBe(true);
  expect(only.find("closeToRight").disabled).toBe(true);
  const shielded = setup({}, [tab("a"), tab("b", { pinned: true }), tab("c", { pinned: true })], 0);
  expect(shielded.find("closeOthers").disabled).toBe(true);
  expect(shielded.find("closeToRight").disabled).toBe(true);
  const last = setup({}, [tab("a"), tab("b")], 1);
  expect(last.find("closeOthers").disabled).toBeFalsy();
  expect(last.find("closeToRight").disabled).toBe(true);
});

it("every label exists in en and vi", () => {
  const walk = (items: MenuItem[]): string[] => items.flatMap((i) => (i.kind === "separator" ? [] : [i.labelKey, ...walk(i.children ?? [])]));
  for (const key of walk(setup().items)) {
    expect(en, key).toHaveProperty([key]);
    expect(viText, key).toHaveProperty([key]);
  }
});

const info = (rel: string, over: Partial<FileTabInfo> = {}): FileTabInfo => ({ rel, dirty: false, pinned: false, ...over });

function fileSetup(over: Partial<FileTabMenuContext> = {}, files: FileTabInfo[] = [info("a.ts"), info("b.md"), info("c.ts")], rel = "b.md") {
  const calls: string[] = [];
  const ctx: FileTabMenuContext = {
    rel,
    files,
    canMoveToSplit: true,
    moveToSplit: (d) => void calls.push(`move:${d}`),
    setPinned: (p) => void calls.push(`pin:${p}`),
    copyPath: () => void calls.push("path"),
    copyRelativePath: () => void calls.push("rel"),
    close: () => void calls.push("close"),
    closeOthers: () => void calls.push("others"),
    closeToRight: () => void calls.push("right"),
    closeSaved: () => void calls.push("saved"),
    closeAll: () => void calls.push("all"),
    ...over,
  };
  const items = fileTabMenuItems(ctx);
  return { calls, items, find: (id: string) => items.find((i) => i.id === id) as MenuItem };
}

it("a file tab menu has the file items and none of the terminal ones", () => {
  expect(ids(fileSetup().items)).toEqual([
    "moveToSplit", "-", "pin", "-", "copyPath", "copyRelativePath", "-",
    "close", "closeOthers", "closeToRight", "closeSaved", "closeAll",
  ]);
  const terminal = ids(setup().items);
  const terminalOnly = ["copyTabId", "changeTitle", "color", "splitRight", "splitDown"];
  for (const id of terminalOnly) {
    expect(terminal).toContain(id);
    expect(ids(fileSetup().items)).not.toContain(id);
  }
  expect(terminal).not.toContain("copyPath");
  expect(terminal).not.toContain("closeAll");
});

it("a Markdown file offers Open preview first; other files do not", () => {
  const calls: string[] = [];
  const md = fileSetup({ openPreview: () => void calls.push("preview") });
  expect(ids(md.items).slice(0, 3)).toEqual(["openPreview", "-", "moveToSplit"]);
  md.find("openPreview").run!();
  expect(calls).toEqual(["preview"]);
  expect(ids(fileSetup().items)).not.toContain("openPreview");
});

it("the file pin item toggles with the tab's mark", () => {
  const free = fileSetup();
  const pinned = fileSetup({}, [info("a.ts"), info("b.md", { pinned: true })]);
  expect(free.find("pin").labelKey).toBe("tabMenu.pin");
  expect(pinned.find("pin").labelKey).toBe("tabMenu.unpin");
  free.find("pin").run!();
  pinned.find("pin").run!();
  expect([...free.calls, ...pinned.calls]).toEqual(["pin:true", "pin:false"]);
});

it("each file item calls its context method", () => {
  const { calls, find } = fileSetup();
  for (const id of ["copyPath", "copyRelativePath", "close", "closeOthers", "closeToRight", "closeSaved", "closeAll"]) find(id).run!();
  find("moveToSplit").children![1].run!();
  expect(calls).toEqual(["path", "rel", "close", "others", "right", "saved", "all", "move:down"]);
});

it("bulk closes leave pinned tabs and work out what is left to close", () => {
  const files = [info("a", { pinned: true }), info("b", { dirty: true }), info("c"), info("d", { dirty: true, pinned: true })];
  expect(fileCloseTargets(files, "b", "others")).toEqual(["c"]);
  expect(fileCloseTargets(files, "a", "right")).toEqual(["b", "c"]);
  expect(fileCloseTargets(files, "b", "right")).toEqual(["c"]);
  expect(fileCloseTargets(files, null, "saved")).toEqual(["c"]);
  expect(fileCloseTargets(files, null, "all")).toEqual(["b", "c"]);
});

it("close saved leaves dirty tabs; close all and others take dirty ones too", () => {
  const files = [info("a", { dirty: true }), info("b"), info("c", { dirty: true })];
  expect(fileCloseTargets(files, "b", "saved")).toEqual(["b"]);
  expect(fileCloseTargets(files, "b", "all")).toEqual(["a", "b", "c"]);
  expect(fileCloseTargets(files, "b", "others")).toEqual(["a", "c"]);
});

it("the bulk items disable when nothing is left to close", () => {
  const alone = fileSetup({}, [info("a.ts")], "a.ts");
  expect(alone.find("closeOthers").disabled).toBe(true);
  expect(alone.find("closeToRight").disabled).toBe(true);
  expect(alone.find("closeSaved").disabled).toBeFalsy();
  const dirty = fileSetup({}, [info("a.ts", { dirty: true })], "a.ts");
  expect(dirty.find("closeSaved").disabled).toBe(true);
  expect(dirty.find("closeAll").disabled).toBeFalsy();
  const pinned = fileSetup({}, [info("a.ts", { pinned: true })], "a.ts");
  expect(pinned.find("closeAll").disabled).toBe(true);
});

it("every file menu label exists in en and vi", () => {
  const walk = (items: MenuItem[]): string[] => items.flatMap((i) => (i.kind === "separator" ? [] : [i.labelKey, ...walk(i.children ?? [])]));
  for (const key of [...walk(fileSetup({ openPreview: () => undefined }).items), "tabMenu.discarded", "tabMenu.reopen"]) {
    expect(en, key).toHaveProperty([key]);
    expect(viText, key).toHaveProperty([key]);
  }
});

const kind = (id: string) => (id.startsWith("file:") ? "file" : id.startsWith("preview:") ? "preview" : "terminal");

it("cycles among the tabs of the same kind, wrapping", () => {
  const all = ["t1", "file:a", "t2", "file:b", "preview:b", "file:c"];
  expect(cycleSameKind(all, "file:a", 1, kind)).toBe("file:b");
  expect(cycleSameKind(all, "file:c", 1, kind)).toBe("file:a");
  expect(cycleSameKind(all, "file:a", -1, kind)).toBe("file:c");
  expect(cycleSameKind(all, "t1", 1, kind)).toBe("t2");
  expect(cycleSameKind(all, "t1", -1, kind)).toBe("t2");
});

it("cycling has nowhere to go for a lone tab of its kind or an unknown tab", () => {
  const all = ["t1", "file:a", "file:b"];
  expect(cycleSameKind(all, "t1", 1, kind)).toBeNull();
  expect(cycleSameKind(all, "zz", 1, kind)).toBeNull();
  expect(cycleSameKind(all, null, 1, kind)).toBeNull();
  expect(cycleSameKind([], "t1", 1, kind)).toBeNull();
});
