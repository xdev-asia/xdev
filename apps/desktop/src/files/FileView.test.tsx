import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { CodeEditor } from "./CodeEditor";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { conflictChange, conflictDecorations } from "./conflictDecorations";
import { parseConflicts } from "./conflictMarkers";
import { ExternalChange } from "./ExternalChangeBanner";
import { ContextMenu } from "@/ui/ContextMenu";
import { FileView } from "./FileView";
import { ImageView } from "./ImageView";
import { MediaView } from "./MediaView";
import { LoadError } from "./LoadError";
import { fileTabs, isDirty } from "./fileTabs";

const hooks = vi.hoisted(() => ({ active: false, effects: [] as (() => void)[], slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    // State by call order, kept between draws, so a menu opened by a handler shows on the next draw.
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const at = hooks.cursor++;
      if (!(at in hooks.slots)) hooks.slots[at] = initial;
      return [hooks.slots[at], (next: unknown) => void (hooks.slots[at] = next)];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
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
const en = (key: string) => translate("en", key);
const W = "C:/wt/a";

const draw = (api: ReturnType<typeof createMockApi>, rel = "a.ts") => {
  hooks.active = true;
  hooks.effects = [];
  hooks.cursor = 0;
  try { return nodes(FileView({ api, worktree: W, rel })); } finally { hooks.active = false; }
};
const ready = (over: Partial<Parameters<typeof fileTabs.loaded>[2]> = {}) => {
  fileTabs.open(W, "a.ts");
  fileTabs.loaded(W, "a.ts", { text: "one", kind: "text", hash: "h1", eol: "lf", size: 3, ...over } as never);
};

beforeEach(() => { fileTabs.reset(); hooks.slots = []; });
afterEach(() => fileTabs.reset());

it("shows the editor for a text file and writes edits into the store", () => {
  ready();
  const editor = draw(createMockApi({})).find((n) => n.type === CodeEditor)!;
  expect(editor.props.value).toBe("one");
  editor.props.onChange("two");
  expect(fileTabs.get(W, "a.ts")!.text).toBe("two");
});

it("the editor's save writes with the loaded hash", async () => {
  const api = createMockApi({});
  const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h2" });
  ready();
  fileTabs.edit(W, "a.ts", "two");
  draw(api).find((n) => n.type === CodeEditor)!.props.onSave();
  await tick();
  expect(write).toHaveBeenCalledWith(W, "a.ts", "two", "lf", "h1");
});

it("a save conflict or a changed-on-disk mark shows the banner; a clean or deleted file does not", () => {
  const api = createMockApi({});
  const shown = () => draw(api).some((n) => n.type === ExternalChange);
  ready();
  expect(shown()).toBe(false);
  fileTabs.edit(W, "a.ts", "mine");
  fileTabs.conflict(W, "a.ts", "disk9");
  expect(shown()).toBe(true);
  fileTabs.keepMine(W, "a.ts", "disk9");
  expect(shown()).toBe(false);
  fileTabs.markExternal(W, "a.ts", "changed");
  expect(shown()).toBe(true);
  // A deleted or renamed file is marked on its tab, not with a bar.
  fileTabs.markExternal(W, "a.ts", "deleted");
  expect(shown()).toBe(false);
});

it("a binary or too large file has no editor, only Reveal in File Manager", async () => {
  for (const kind of ["binary", "tooLarge"] as const) {
    fileTabs.reset();
    const api = createMockApi({});
    const reveal = vi.spyOn(api, "fileReveal").mockResolvedValue(undefined);
    ready({ kind, text: null } as never);
    const all = draw(api);
    expect(all.find((n) => n.type === CodeEditor)).toBeUndefined();
    all.find((n) => n.type === "button" && n.props.children === en("files.menu.reveal"))!.props.onClick();
    expect(reveal).toHaveBeenCalledWith(W, "a.ts");
  }
});

it("reads the file once while it is loading", () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "fileRead");
  fileTabs.open(W, "a.ts");
  const all = draw(api);
  expect(all.some((n) => n.props.children === en("files.loading"))).toBe(true);
  hooks.effects.forEach((e) => e());
  expect(read).toHaveBeenCalledWith(W, "a.ts");
});

const CONFLICTED = ["a", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "z"].join("\n");

// The bar is a widget of the editor's state; without a DOM it is read from the decorations the editor would draw.
const bars = (editor: Node): number => {
  const state = EditorState.create({ doc: editor.props.value, extensions: [conflictDecorations(() => ({ bar: () => "bar", current: "c", incoming: "i", both: "b" }))] });
  let count = 0;
  for (const source of state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(null as unknown as EditorView) : source;
    for (const it = set.iter(); it.value; it.next()) if (it.value.spec.widget) count++;
  }
  return count;
};

it("a file with conflict markers reaches the editor with its text, so the conflict bar shows", () => {
  ready({ text: CONFLICTED });
  const editor = draw(createMockApi({})).find((n) => n.type === CodeEditor)!;
  expect(editor.props.rel).toBe("a.ts");
  expect(bars(editor)).toBe(1);
  fileTabs.reset();
  ready();
  expect(bars(draw(createMockApi({})).find((n) => n.type === CodeEditor)!)).toBe(0);
});

it("accepting a side edits the buffer and marks the tab dirty, without writing", () => {
  const api = createMockApi({});
  const write = vi.spyOn(api, "fileWrite");
  ready({ text: CONFLICTED });
  expect(isDirty(fileTabs.get(W, "a.ts")!)).toBe(false);
  const editor = draw(api).find((n) => n.type === CodeEditor)!;
  const state = EditorState.create({ doc: editor.props.value });
  const next = state.update({ changes: conflictChange(state, parseConflicts(editor.props.value)[0], "incoming") }).state.doc.toString();
  editor.props.onChange(next);
  expect(fileTabs.get(W, "a.ts")!.text).toBe("a\ntheirs\nz");
  expect(isDirty(fileTabs.get(W, "a.ts")!)).toBe(true);
  expect(write).not.toHaveBeenCalled();
  // The conflict is settled: the next draw has no bar.
  expect(bars(draw(api).find((n) => n.type === CodeEditor)!)).toBe(0);
});

it("a right click on the gutter opens a menu with the three copy rows, and closing clears it", () => {
  ready();
  const api = createMockApi({});
  expect(draw(api).some((n) => n.type === ContextMenu)).toBe(false);
  draw(api).find((n) => n.type === CodeEditor)!.props.onGutterMenu({ x: 5, y: 6 }, 7, null);
  const menu = draw(api).find((n) => n.type === ContextMenu)!;
  expect(menu.props.at).toEqual({ x: 5, y: 6 });
  expect(menu.props.label).toBe(en("editor.gutter.label"));
  expect(menu.props.items.map((i: { id: string }) => i.id)).toEqual(["copyPath", "copyRelPath", "copyRemote", "createTask"]);
  menu.props.onClose();
  expect(draw(api).some((n) => n.type === ContextMenu)).toBe(false);
});

it("does not read an image or media file as text", () => {
  for (const rel of ["pic.png", "clip.mp4", "song.mp3"]) {
    const api = createMockApi({});
    const read = vi.spyOn(api, "fileRead");
    fileTabs.open(W, rel);
    const all = draw(api, rel);
    expect(all.find((n) => n.type === CodeEditor)).toBeUndefined();
    hooks.effects.forEach((e) => e());
    expect(read).not.toHaveBeenCalled();
  }
});

it("an image or media file the watcher saw go shows not found, and Retry brings the view back", () => {
  for (const rel of ["pic.png", "clip.mp4"]) {
    const api = createMockApi({});
    fileTabs.open(W, rel);
    fileTabs.markExternal(W, rel, "deleted");
    const error = draw(api, rel).find((n) => n.type === LoadError)!;
    expect(error.props.code).toBe("not_found");
    error.props.onRetry();
    expect(fileTabs.get(W, rel)!.external).toBeNull();
    expect(draw(api, rel).find((n) => n.type === LoadError)).toBeUndefined();
  }
});

it("reads an svg as text first, then routes it by what the read found", () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "fileRead");
  fileTabs.open(W, "logo.svg");
  draw(api, "logo.svg");
  hooks.effects.forEach((e) => e());
  expect(read).toHaveBeenCalledWith(W, "logo.svg");
});

it("a failed read shows the title, the reason and Retry; Retry reads again and recovers", async () => {
  const api = createMockApi({});
  fileTabs.open(W, "a.ts");
  fileTabs.failed(W, "a.ts", "io");
  const error = draw(api).find((n) => n.type === LoadError)!;
  expect(error.props.code).toBe("io");
  const read = vi.spyOn(api, "fileRead").mockResolvedValue({ text: "back", kind: "text", hash: "h", eol: "lf", size: 4 } as never);
  error.props.onRetry();
  await tick();
  expect(read).toHaveBeenCalledWith(W, "a.ts");
  expect(fileTabs.get(W, "a.ts")).toMatchObject({ status: "ready", text: "back" });
});

it("the load error says what failed and has one primary button, Retry, and a Reveal", () => {
  hooks.active = true;
  try {
    const all = nodes(LoadError({ code: "io", onRetry() {}, onReveal() {} }));
    expect(all.some((n) => n.props.children === en("files.loadError.title"))).toBe(true);
    expect(all.some((n) => n.props.children === en("error.io"))).toBe(true);
    expect(all.some((n) => n.props.children === en("files.retry"))).toBe(true);
    const reveal = all.find((n) => n.type === "button" && n.props.children === en("files.menu.reveal"))!;
    expect(reveal.props.className).toBe("btn-secondary");
  } finally { hooks.active = false; }
});

it("a read refused as too large keeps the too large note", () => {
  fileTabs.open(W, "a.ts");
  fileTabs.failed(W, "a.ts", "too_large");
  const all = draw(createMockApi({}));
  expect(all.find((n) => n.type === LoadError)).toBeUndefined();
  expect(all.some((n) => n.props.children === en("files.tooLarge"))).toBe(true);
});

it("an image or media view is drawn anew when its file changed on disk", () => {
  for (const [rel, View] of [["pic.png", ImageView], ["clip.mp4", MediaView]] as const) {
    fileTabs.open(W, rel);
    const keyOf = () => draw(createMockApi({}), rel).find((n) => n.type === View)!.key;
    const before = keyOf();
    fileTabs.revise(W, rel);
    expect(keyOf()).not.toBe(before);
  }
});

it("the editor's wrap key and the more menu flip the shared word wrap setting", async () => {
  const api = createMockApi({});
  const put = vi.spyOn(api, "editorSettingsPut").mockImplementation(async (v) => v);
  ready();
  draw(api).find((n) => n.type === CodeEditor)!.props.onToggleWrap();
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ wordWrap: false }));
  // The toolbar has previous and next change buttons, off while the text has no change.
  const buttons = draw(api).filter((n) => n.props.label === en("files.change.prev") || n.props.label === en("files.change.next"));
  expect(buttons).toHaveLength(2);
  expect(buttons.every((b) => b.props.disabled)).toBe(true);
});
