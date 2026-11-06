// There is no DOM in these tests, so `codemirror`'s EditorView is a small stand-in that keeps the real
// EditorState (documents, selections, compartments, annotations, facets) and runs the update listeners.
import { EditorSelection } from "@codemirror/state";
import { EditorView as RealView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import type { EditorSettings } from "@/api";
import { registerEditorPlugin } from "./editorPlugins";
import { CodeEditor } from "./CodeEditor";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], slots: [] as unknown[], cursor: 0, views: [] as any[] }));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useRef: (initial: unknown) => {
      const at = hooks.cursor++;
      if (!(at in hooks.slots)) hooks.slots[at] = { current: initial };
      return hooks.slots[at];
    },
    // Like React: an effect runs again only when its dependencies changed.
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const at = hooks.cursor++;
      const last = hooks.slots[at] as unknown[] | undefined;
      if (deps && last && deps.length === last.length && deps.every((d, i) => Object.is(d, last[i]))) return;
      hooks.slots[at] = deps ?? [{}];
      hooks.effects.push(effect);
    },
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  };
});
vi.mock("codemirror", async () => {
  const view = await import("@codemirror/view");
  class FakeView {
    state: import("@codemirror/state").EditorState;
    constructor(cfg: { state: import("@codemirror/state").EditorState }) {
      this.state = cfg.state;
      hooks.views.push(this);
    }
    dispatch(spec: import("@codemirror/state").TransactionSpec) {
      const tr = this.state.update(spec);
      this.state = tr.state;
      for (const fn of tr.state.facet(view.EditorView.updateListener)) fn({ docChanged: tr.docChanged, transactions: [tr], state: tr.state } as never);
    }
    focus() {}
    destroy() {}
  }
  // The statics (theme, updateListener, …) are the real ones; only the instance is a stand-in.
  Object.setPrototypeOf(FakeView, view.EditorView);
  return { EditorView: FakeView, basicSetup: [] };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

const settings = { wordWrap: false, tabSize: 2, fontSize: 13, fontFamily: "" } as EditorSettings;

// One editor with its own hook slots, drawn again with new props.
function mount(initial: { value: string; secondary?: boolean; goto?: { line: number; seq: number }; extra?: Record<string, unknown> }) {
  hooks.slots = [];
  hooks.views = [];
  const edits: string[] = [];
  const props = (over: Partial<{ value: string; goto: { line: number; seq: number } }> = {}) => ({
    worktree: "/wt",
    rel: "a.txt",
    value: initial.value,
    secondary: initial.secondary,
    goto: initial.goto,
    settings,
    onChange: (text: string) => void edits.push(text),
    onSave: () => undefined,
    ...initial.extra,
    ...over,
  });
  const draw = (over: Parameters<typeof props>[0] = {}) => {
    hooks.effects = [];
    hooks.cursor = 0;
    CodeEditor(props(over));
    for (const run of hooks.effects) run();
  };
  draw();
  return { draw, edits, view: () => hooks.views[0] as RealView };
}

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

it("a value change from props keeps a selection that sits before the change", () => {
  const ed = mount({ value: "hello world" });
  ed.view().dispatch({ selection: EditorSelection.cursor(2) });
  ed.draw({ value: "hello brave world" });
  expect(ed.view().state.doc.toString()).toBe("hello brave world");
  expect(ed.view().state.selection.main.head).toBe(2);
  // A change pushed in from props is not an edit.
  expect(ed.edits).toEqual([]);
});

it("a caret after the change moves with the text", () => {
  const ed = mount({ value: "hello world" });
  ed.view().dispatch({ selection: EditorSelection.cursor(11) });
  ed.draw({ value: "hello brave world" });
  expect(ed.view().state.selection.main.head).toBe(17);
});

it("a typed edit reaches onChange", () => {
  const ed = mount({ value: "ab" });
  ed.view().dispatch({ changes: { from: 2, insert: "c" } });
  expect(ed.edits).toEqual(["abc"]);
});

it("a registered plugin extension is active, and one registered later is picked up", () => {
  offs.push(registerEditorPlugin("test.early", () => RealView.editorAttributes.of({ class: "early" })));
  const ed = mount({ value: "x" });
  const classes = () => ed.view().state.facet(RealView.editorAttributes).map((a) => (a as { class?: string }).class);
  expect(classes()).toContain("early");
  offs.push(registerEditorPlugin("test.late", () => RealView.editorAttributes.of({ class: "late" })));
  ed.draw();
  expect(classes()).toContain("late");
});

it("a secondary view ignores goto; the primary one jumps", () => {
  const goto = { line: 2, seq: 1 };
  const primary = mount({ value: "one\ntwo\nthree", goto });
  expect(primary.view().state.selection.main.head).toBe(4);
  const second = mount({ value: "one\ntwo\nthree", goto, secondary: true });
  expect(second.view().state.selection.main.head).toBe(0);
  second.draw({ goto: { line: 3, seq: 2 } });
  expect(second.view().state.selection.main.head).toBe(0);
});

it("compares with the base: reports the change count, and the controls walk the changes", () => {
  let controls: { goChange(dir: 1 | -1): void } | null = null;
  const counts: number[] = [];
  const ed = mount({
    value: ["a", "B", "c", "d", "E"].join("\n"),
    extra: { base: ["a", "b", "c", "d", "e"].join("\n"), onControls: (c: typeof controls) => (controls = c), onChangeCount: (n: number) => void counts.push(n) },
  });
  expect(counts.at(-1)).toBe(2);
  const line = () => ed.view().state.doc.lineAt(ed.view().state.selection.main.head).number;
  controls!.goChange(1);
  expect(line()).toBe(2);
  controls!.goChange(1);
  expect(line()).toBe(5);
  controls!.goChange(-1);
  expect(line()).toBe(2);
});

it("the editor font family is the setting, else the terminal's, ending with the mono token", () => {
  const style = (CodeEditor({ worktree: "/wt", rel: "a.txt", value: "", settings: { ...settings, fontFamily: "Fira Code" }, onChange() {}, onSave() {} }) as { props: { style: Record<string, string> } }).props.style;
  expect(style["--editor-font-family"]).toBe("Fira Code, var(--x-font-mono)");
});
