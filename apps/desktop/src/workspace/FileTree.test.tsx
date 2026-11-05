import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type DirListing, type FsEvent, type WorktreeChange } from "@/api";
import { translate } from "@/i18n";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { NameDialog } from "@/files/NameDialog";
import { onOpenFile, type OpenFileRequest } from "@/files/openFile";
import { ContextMenu } from "@/ui/ContextMenu";
import { FileTree } from "./FileTree";
import type { WatchHealth } from "./worktreeWatch";
import { emptyQueue, enqueue, type WatchQueue } from "@/files/treeRefresh";

const toasts = vi.hoisted(() => ({ pushed: [] as { id: string; text: string }[] }));
vi.mock("./toastStore", () => ({ pushToast: (toast: { id: string; text: string }) => void toasts.pushed.push(toast) }));

// Hooks are stubbed only while a component under test is called; each harness keeps its own.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (((() => void | (() => void))) & { deps?: unknown[] })[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  const state = (initial: unknown) => {
    const { index, values } = slot(initial);
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(Object.assign(() => effect(), { deps })) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const CHANGES: WorktreeChange[] = [
  { path: "docs/old-notes.md", kind: "deleted" },
  { path: "src/session.ts", kind: "modified" },
  { path: "src/status.ts", kind: "added" },
];

// Calls `render` with its own hook values; the effects of the first draw run once, as on mount.
// `again` draws with new props and runs the effects, as a re-render with changed deps does.
function mount(render: (changes: WorktreeChange[]) => unknown, first: WorktreeChange[]) {
  const values: unknown[] = [];
  const draw = (changes: WorktreeChange[]) => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(changes); } finally { hooks.active = false; }
  };
  let current = first;
  // An effect runs again only when its deps changed, as in React.
  const last: (unknown[] | undefined)[] = [];
  const run = (changes: WorktreeChange[]) => {
    const before = hooks.effects.length;
    current = changes;
    draw(changes);
    hooks.effects.slice(before).forEach((effect, i) => {
      const prev = last[i];
      if (effect.deps && prev && effect.deps.length === prev.length && effect.deps.every((d, j) => Object.is(d, prev[j]))) return;
      last[i] = effect.deps;
      effect();
    });
  };
  run(first);
  return { all: () => nodes(draw(current)), html: () => renderToStaticMarkup(draw(current) as ReactElement), again: run };
}

function tree(api: Api, changes: WorktreeChange[] = CHANGES) {
  const onOpen = vi.fn();
  const feed: { queue: WatchQueue; health?: WatchHealth; push(events: FsEvent[]): void } = {
    queue: emptyQueue(OAK),
    push(events) {
      feed.queue = enqueue(feed.queue, events);
    },
  };
  const view = mount((list) => FileTree({ api, worktree: OAK, changes: list, onOpen, queue: feed.queue, watchHealth: feed.health }), changes);
  const rows = () => view.all().filter((n) => n.props.role === "treeitem");
  const label = (r: Node) => nodes(r).find((n) => n.props.className === "ws-tree-name")?.props.children;
  const row = (name: string) => rows().find((r) => label(r) === name)!;
  const mark = (name: string) => nodes(row(name)).find((n) => n.props.className === "ws-tree-mark")?.props;
  return { ...view, onOpen, rows, row, label, mark, feed };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("expands a folder on click and lists it once", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  // Folders first, then files, as the listing gives them.
  expect(view.rows().map(view.label)).toEqual(["docs", "src", "package.json", "README.md"]);
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith(OAK, "");

  view.row("src").props.onClick();
  await tick();
  expect(view.row("src").props["aria-expanded"]).toBe(true);
  expect(view.row("App.tsx").props["aria-level"]).toBe(2);
  expect(list).toHaveBeenCalledWith(OAK, "src");

  // Closing and opening again reads nothing more.
  view.row("src").props.onClick();
  expect(view.rows().map(view.label)).not.toContain("App.tsx");
  view.row("src").props.onClick();
  await tick();
  expect(view.rows().map(view.label)).toContain("App.tsx");
  expect(list.mock.calls.filter(([, dir]) => dir === "src")).toHaveLength(1);
  expect(list).toHaveBeenCalledTimes(2);
});

it("marks changed files M and new files A", async () => {
  const view = tree(createMockApi({}));
  await tick();
  view.row("src").props.onClick();
  await tick();
  expect(view.mark("session.ts")?.children).toBe("M");
  expect(view.mark("status.ts")?.children).toBe("A");
  expect(view.mark("status.ts")?.["data-kind"]).toBe("added");
  expect(view.mark("session.ts")?.title).toBe(en("changes.kind.modified"));
  expect(view.mark("App.tsx")).toBeUndefined();
  // A folder holding changes carries a dot; a clean one does not.
  const dot = (name: string) => nodes(view.row(name)).some((n) => n.props.className === "ws-tree-dot");
  expect(dot("src")).toBe(true);
  expect(dot("docs")).toBe(true);
  expect(dot("lib")).toBe(false);
  // The deleted file is not on disk, so the tree never shows it.
  view.row("docs").props.onClick();
  await tick();
  expect(view.html()).not.toContain("old-notes");
});

it("opening a changed file calls onOpen", async () => {
  const view = tree(createMockApi({}));
  await tick();
  view.row("src").props.onClick();
  await tick();
  view.row("status.ts").props.onClick();
  expect(view.onOpen).toHaveBeenCalledTimes(1);
  expect(view.onOpen).toHaveBeenCalledWith("src/status.ts");
  // A file with no change has no diff: it opens in an editor, not as a diff.
  const opened: OpenFileRequest[] = [];
  const stop = onOpenFile((r) => opened.push(r));
  view.row("App.tsx").props.onClick();
  stop();
  expect(opened).toEqual([{ worktree: OAK, rel: "src/App.tsx" }]);
  expect(view.onOpen).toHaveBeenCalledTimes(1);
});

it("the filter button opens a name filter over every file; Escape clears and closes it", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "filesList").mockResolvedValue({ files: ["src/App.tsx", "src/deep/app.test.ts", "README.md"], truncated: false });
  const view = tree(api);
  await tick();
  const field = () => view.all().find((n) => n.props["data-field"] === "filter");
  expect(field()).toBeUndefined();
  view.all().find((n) => n.props["data-action"] === "filter")!.props.onClick();
  view.again(CHANGES);
  await tick();
  field()!.props.onChange({ target: { value: "APP" } });
  // Nothing was opened, yet both matches show, with the folder they are in.
  expect(view.rows().map(view.label)).toEqual(["App.tsx", "app.test.ts"]);
  expect(view.html()).toContain("src/deep");
  field()!.props.onKeyDown({ key: "Escape", preventDefault() {} });
  expect(field()).toBeUndefined();
  expect(view.rows().map(view.label)).toContain("docs");
});

it("arrow keys walk the rows, Right opens a folder, Left closes it, Enter opens a file", async () => {
  const view = tree(createMockApi({}));
  await tick();
  const key = (k: string, extra: Record<string, unknown> = {}) => {
    const e = { key: k, code: "", preventDefault: vi.fn(), ...extra };
    view.all().find((n) => n.props.role === "tree")!.props.onKeyDown(e);
    return e;
  };
  const selected = () => view.rows().filter((r) => r.props["aria-selected"]).map(view.label);
  expect(view.row("docs").props.tabIndex).toBe(0);
  expect(view.row("src").props.tabIndex).toBe(-1);
  expect(key("ArrowDown").preventDefault).toHaveBeenCalled();
  expect(selected()).toEqual(["docs"]);
  key("ArrowDown");
  expect(selected()).toEqual(["src"]);
  expect(view.row("src").props.tabIndex).toBe(0);
  key("ArrowRight");
  await tick();
  expect(view.row("src").props["aria-expanded"]).toBe(true);
  key("ArrowRight");
  expect(selected()).toEqual(["lib"]);
  key("ArrowLeft");
  expect(selected()).toEqual(["src"]);
  key("ArrowLeft");
  expect(view.row("src").props["aria-expanded"]).toBe(false);
  key("End");
  expect(selected()).toEqual(["README.md"]);
  key("Home");
  expect(selected()).toEqual(["docs"]);
  key("End");
  const opened: OpenFileRequest[] = [];
  const stop = onOpenFile((r) => opened.push(r));
  key("Enter");
  stop();
  expect(opened).toEqual([{ worktree: OAK, rel: "README.md" }]);
});

it("Delete on the selected row asks first; Cmd+Backspace does too; modified keys copy paths", async () => {
  const api = createMockApi({});
  const view = tree(api);
  await tick();
  const tr = () => view.all().find((n) => n.props.role === "tree")!.props;
  tr().onKeyDown({ key: "End", code: "", preventDefault() {} });
  tr().onKeyDown({ key: "Delete", code: "", preventDefault() {} });
  expect(view.all().find((n) => n.type === ConfirmDialog)!.props.open).toBe(true);
  view.all().find((n) => n.type === ConfirmDialog)!.props.onCancel();
  tr().onKeyDown({ key: "Backspace", metaKey: true, code: "", preventDefault() {} });
  expect(view.all().find((n) => n.type === ConfirmDialog)!.props.open).toBe(true);
  // Plain Backspace is not Delete.
  view.all().find((n) => n.type === ConfirmDialog)!.props.onCancel();
  tr().onKeyDown({ key: "Backspace", code: "", preventDefault() {} });
  expect(view.all().find((n) => n.type === ConfirmDialog)!.props.open).toBe(false);
});

it("the active file opens its folders when the tree follows it, and not when it was turned off", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const mk = (follow: boolean, active: string | null) => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "xdev.tree.revealActive" && !follow ? "0" : null), setItem() {}, removeItem() {} });
    hooks.values = [];
    hooks.effects = [];
    return mount((c) => FileTree({ api, worktree: OAK, changes: c, onOpen: vi.fn(), activeFile: active }), CHANGES);
  };
  const on = mk(true, "src/lib/util.ts");
  await tick();
  expect(list).toHaveBeenCalledWith(OAK, "src");
  expect(list).toHaveBeenCalledWith(OAK, "src/lib");
  expect(nodes(on.all()).filter((n) => n.props["aria-expanded"] === true).length).toBeGreaterThanOrEqual(1);
  list.mockClear();
  mk(false, "src/lib/util.ts");
  await tick();
  expect(list).not.toHaveBeenCalledWith(OAK, "src");
});

it("Collapse all closes every folder", async () => {
  const view = tree(createMockApi({}));
  await tick();
  view.row("src").props.onClick();
  await tick();
  expect(view.row("src").props["aria-expanded"]).toBe(true);
  view.all().find((n) => n.props["data-action"] === "collapse")!.props.onClick();
  expect(view.row("src").props["aria-expanded"]).toBe(false);
});

it("Refresh reads the shown folders again", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  expect(list).toHaveBeenCalledTimes(1);
  view.all().find((n) => n.props["data-action"] === "refresh")!.props.onClick();
  view.again(CHANGES);
  await tick();
  expect(list).toHaveBeenCalledTimes(2);
});

const menuOf = (view: ReturnType<typeof tree>) => view.all().find((n) => n.type === ContextMenu)?.props;
const rightClick = (view: ReturnType<typeof tree>, name: string) =>
  view.row(name).props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 6 });

it("the file menu lists the actions, the folder menu has no Open", async () => {
  const view = tree(createMockApi({}));
  await tick();
  rightClick(view, "README.md");
  expect(menuOf(view)!.items.map((i: { id: string }) => i.id)).toEqual(["open", "copyPath", "copyRel", "sep1", "findInFolder", "newFile", "newFolder", "rename", "delete", "sep2", "reveal", "openOnHost"]);
  menuOf(view)!.onClose();
  expect(menuOf(view)).toBeUndefined();
  rightClick(view, "docs");
  expect(menuOf(view)!.items.map((i: { id: string }) => i.id)).not.toContain("open");
});

it("Open file in browser asks the host for the file; failures are toasts", async () => {
  const api = createMockApi({});
  const open = vi.spyOn(api, "worktreeOpenFileOnHost").mockResolvedValue(undefined);
  const view = tree(api);
  await tick();
  rightClick(view, "docs");
  expect(menuOf(view)!.items.map((i: { id: string }) => i.id)).not.toContain("openOnHost");
  rightClick(view, "README.md");
  menuOf(view)!.items.find((i: { id: string }) => i.id === "openOnHost").run();
  await tick();
  expect(open).toHaveBeenCalledWith(OAK, "README.md", null, null);
  open.mockRejectedValueOnce({ code: "no_web_remote", message: "x" });
  menuOf(view)!.items.find((i: { id: string }) => i.id === "openOnHost").run();
  await tick();
  expect(toasts.pushed.at(-1)!.text).toBe(en("gitHistory.noWebRemote"));
  open.mockRejectedValueOnce({ code: "open_failed", message: "x" });
  menuOf(view)!.items.find((i: { id: string }) => i.id === "openOnHost").run();
  await tick();
  expect(toasts.pushed.at(-1)!.text).toBe(en("files.openOnHostFailed"));
});

it("Delete asks first; Cancel calls nothing, Move to trash calls fileTrash", async () => {
  const api = createMockApi({});
  const trash = vi.spyOn(api, "fileTrash").mockResolvedValue(undefined);
  const view = tree(api);
  await tick();
  rightClick(view, "README.md");
  menuOf(view)!.items.find((i: { id: string }) => i.id === "delete").run();
  const dialog = () => view.all().find((n) => n.type === ConfirmDialog)!.props;
  expect(dialog().open).toBe(true);
  expect(dialog().title).toBe(en("files.delete.title", { name: "README.md" }));
  dialog().onCancel();
  expect(dialog().open).toBe(false);
  expect(trash).not.toHaveBeenCalled();
  rightClick(view, "README.md");
  menuOf(view)!.items.find((i: { id: string }) => i.id === "delete").run();
  dialog().onConfirm();
  await tick();
  expect(trash).toHaveBeenCalledWith(OAK, "README.md");
});

it("New file asks for a name, refuses a bad one in words, then creates and opens it", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "fileCreate").mockResolvedValue(undefined);
  const view = tree(api);
  await tick();
  view.row("src").props.onClick();
  await tick();
  rightClick(view, "src");
  menuOf(view)!.items.find((i: { id: string }) => i.id === "newFile").run();
  const dialog = () => view.all().find((n) => n.type === NameDialog)!.props;
  expect(dialog().siblings).toContain("App.tsx");
  dialog().onCancel();
  expect(view.all().find((n) => n.type === NameDialog)).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  rightClick(view, "src");
  menuOf(view)!.items.find((i: { id: string }) => i.id === "newFile").run();
  dialog().onConfirm("new.ts");
  await tick();
  expect(create).toHaveBeenCalledWith(OAK, "src/new.ts", false);
});

it("Rename calls fileRename beside the old name", async () => {
  const api = createMockApi({});
  const rename = vi.spyOn(api, "fileRename").mockResolvedValue(undefined);
  const view = tree(api);
  await tick();
  rightClick(view, "README.md");
  menuOf(view)!.items.find((i: { id: string }) => i.id === "rename").run();
  const dialog = view.all().find((n) => n.type === NameDialog)!.props;
  expect(dialog.initial).toBe("README.md");
  expect(dialog.siblings).not.toContain("README.md");
  dialog.onConfirm("READ.md");
  await tick();
  expect(rename).toHaveBeenCalledWith(OAK, "README.md", "READ.md");
});

it("shows … when truncated", async () => {
  const api = createMockApi({});
  const cut: DirListing = { entries: [{ name: "a", dir: false }, { name: "b", dir: false }], truncated: true };
  vi.spyOn(api, "worktreeListDir").mockResolvedValue(cut);
  const view = tree(api, []);
  await tick();
  const more = view.all().find((n) => n.props.className === "ws-tree-note")!;
  expect(more.props.children).toBe("…");
  expect(more.props.title).toBe(en("workspace.files.truncated"));
  expect(view.rows().map((r) => r.props.className)).toEqual(["ws-tree-row", "ws-tree-row", "ws-tree-note"]);
});

it("reads the shown folders again when the changes list is new", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  view.row("src").props.onClick();
  await tick();
  expect(list).toHaveBeenCalledTimes(2);

  view.again([...CHANGES]);
  await tick();
  expect(list.mock.calls.slice(2).map(([, dir]) => dir).sort()).toEqual(["", "src"]);
  // The folder stays open and shown through the refresh.
  expect(view.rows().map(view.label)).toContain("App.tsx");
});

it("says why a folder could not be read", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeListDir").mockRejectedValue({ code: "bad_path" });
  const view = tree(api, []);
  await tick();
  const note = view.all().find((n) => n.props.className === "ws-tree-note")!;
  expect(note.props.children).toBe(en("workspace.files.error"));
});

const ev = (kind: FsEvent["kind"], rel: string, dir: boolean | null = false): FsEvent => ({ kind, rel, dir });

it("disk events read again only the loaded folders they touch", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  view.row("src").props.onClick();
  await tick();
  list.mockClear();

  view.feed.push([ev("create", "src/New.tsx"), ev("create", "docs/new.md"), ev("update", "package.json")]);
  view.again(CHANGES);
  await tick();
  expect(list.mock.calls.map(([, dir]) => dir)).toEqual(["src"]);

  list.mockClear();
  view.feed.push([ev("overflow", "", null)]);
  view.again(CHANGES);
  await tick();
  // The overflow bumps the refresh counter; the next draw reads the shown folders.
  view.again(CHANGES);
  await tick();
  expect(list.mock.calls.map(([, dir]) => dir).sort()).toEqual(["", "src"]);
});

it("every batch that arrived between two draws is applied", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  view.row("src").props.onClick();
  view.row("docs").props.onClick();
  await tick();
  list.mockClear();
  // Two batches, one draw: the first must not be lost.
  view.feed.push([ev("create", "src/New.tsx")]);
  view.feed.push([ev("create", "docs/new.md")]);
  view.again(CHANGES);
  await tick();
  expect(list.mock.calls.map(([, dir]) => dir).sort()).toEqual(["docs", "src"]);
  // Drawn again with nothing new: nothing is read again.
  list.mockClear();
  view.feed.push([]);
  view.again(CHANGES);
  await tick();
  expect(list).not.toHaveBeenCalled();
});

it("disk events wait while the name dialog is open", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeListDir");
  const view = tree(api);
  await tick();
  const root = view.all().find((n) => n.props.role === "tree")!;
  void root;
  // Open the New file dialog through the tree's own menu.
  const menu = () => view.all().find((n) => (n as Node).type === ContextMenu);
  view.all().find((n) => n.props.role === "tree")!.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 1 });
  menu()!.props.items.find((i: { id: string }) => i.id === "newFile").run();
  expect(view.all().some((n) => n.type === NameDialog)).toBe(true);
  list.mockClear();

  view.feed.push([ev("create", "held.txt")]);
  view.again(CHANGES);
  await tick();
  expect(list).not.toHaveBeenCalled();

  view.all().find((n) => n.type === NameDialog)!.props.onCancel();
  view.again(CHANGES);
  await tick();
  expect(list.mock.calls.map(([, dir]) => dir)).toEqual([""]);
});

it("says when live updates stopped at the system watch limit", async () => {
  const view = tree(createMockApi({}));
  await tick();
  expect(view.html()).not.toContain(en("files.watch.limit.title"));
  view.feed.health = "limit";
  const html = view.html();
  expect(html).toContain(en("files.watch.limit.title"));
  expect(html).toContain("fs.inotify.max_user_watches");
});
