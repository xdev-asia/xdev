import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import type { ReviewNote } from "@/api";
import { NoteCard, noteLabel, renderNote } from "./NoteCard";
import { NoteComposer } from "./NoteComposer";
import { newNote } from "./notes";

// Hooks are stubbed only while a component under test is called.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
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
    // The profile store is outside what these tests render; its context keeps the default.
    useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const START = "5555555555555555555555555555555555555555";
// Calls `render` with its own hook values; the first draw's effects run once, as on mount.
function mount(render: () => unknown) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  const cleanups = hooks.effects.slice(before).map((effect) => effect());
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw() as ReactElement);
  const find = (pick: (n: Node) => boolean) => all().find(pick);
  return { draw, all, html, find, cleanups };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => vi.restoreAllMocks());

const typed = (c: ReturnType<typeof mount>, value: string) => c.find((n) => n.type === "textarea")!.props.onChange({ target: { value } });
const press = (c: ReturnType<typeof mount>, extra: object) => {
  const e = { key: "Enter", ctrlKey: false, metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
  c.find((n) => n.type === "textarea")!.props.onKeyDown(e);
  return e;
};

it("composer: Ctrl+Enter saves the trimmed body", () => {
  const onSave = vi.fn();
  const c = mount(() => NoteComposer({ label: "a.ts:3", onSave, onCancel: vi.fn() }));
  typed(c, "  fix this \n");
  press(c, { ctrlKey: true });
  expect(onSave).toHaveBeenCalledWith("fix this");
});

it("composer: plain Enter adds a line and Esc cancels", () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const c = mount(() => NoteComposer({ label: "a.ts:3", onSave, onCancel }));
  typed(c, "x");
  press(c, {});
  expect(onSave).not.toHaveBeenCalled();
  const e = press(c, { key: "Escape" });
  expect(onCancel).toHaveBeenCalled();
  // The editor behind it must not see the key.
  expect(e.stopPropagation).toHaveBeenCalled();
});

it("composer: an empty note cannot be saved", () => {
  const onSave = vi.fn();
  const c = mount(() => NoteComposer({ label: "a.ts:3", onSave, onCancel: vi.fn() }));
  expect(c.find((n) => n.type === "button" && n.props.children === en("review.note.save"))!.props.disabled).toBe(true);
  typed(c, "  \n ");
  press(c, { ctrlKey: true });
  expect(onSave).not.toHaveBeenCalled();
});

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({ ...newNote("src/a.ts", 3, 3, "x", "body", 1, "n1"), ...over });

it("card shows the location, the sent mark and the outdated mark", () => {
  expect(noteLabel(note())).toBe("src/a.ts:3");
  expect(noteLabel(note({ startLine: 3, line: 5 }))).toBe("src/a.ts:3–5");
  const plain = mount(() => NoteCard({ note: note(), onEdit: vi.fn(), onDelete: vi.fn() })).html();
  expect(plain).toContain("src/a.ts:3");
  expect(plain).not.toContain("rv-mark");

  const marked = mount(() => NoteCard({ note: note({ sentAt: 5, outdated: true }), onEdit: vi.fn(), onDelete: vi.fn() })).html();
  expect(marked).toContain(en("review.note.sent"));
  expect(marked).toContain(en("review.note.outdated"));
});

it("card renders Markdown and never raw HTML or live links", () => {
  const html = renderNote("- one\n- two\n\n`code` <img src=x onerror=alert(1)> [go](javascript:alert(1)) https://example.com");
  expect(html).toContain("<ul>");
  expect(html).toContain("<code>code</code>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("href=");
  expect(html).toContain("data-external");
});

it("card: Edit opens the composer with the body, Delete calls back", () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const c = mount(() => NoteCard({ note: note({ body: "old" }), onEdit, onDelete }));
  c.find((n) => n.type === "button" && n.props.children === en("review.note.delete"))!.props.onClick();
  expect(onDelete).toHaveBeenCalled();
  c.find((n) => n.type === "button" && n.props.children === en("review.note.edit"))!.props.onClick();
  const composer = c.find((n) => n.type === NoteComposer)!;
  expect(composer.props.initial).toBe("old");
  composer.props.onSave("new");
  expect(onEdit).toHaveBeenCalledWith("new");
  expect(c.find((n) => n.type === NoteComposer)).toBeUndefined();
});

it("card: Post on PR shows only when the view offers it", () => {
  const without = mount(() => NoteCard({ note: note(), onEdit: vi.fn(), onDelete: vi.fn() })).html();
  expect(without).not.toContain(en("review.note.postToPr"));
  const withPost = mount(() => NoteCard({ note: note(), onEdit: vi.fn(), onDelete: vi.fn(), onPostToPr: async () => {} })).html();
  expect(withPost).toContain(en("review.note.postToPr"));
});

it("card: posting hands the note over once, then shows it posted", async () => {
  const post = vi.fn(async () => {});
  const n = note();
  const c = mount(() => NoteCard({ note: n, onEdit: vi.fn(), onDelete: vi.fn(), onPostToPr: post }));
  const button = () => c.find((x) => "data-post-pr" in x.props)!;
  button().props.onClick();
  button().props.onClick();
  await tick();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(n);
  expect(c.html()).toContain(en("review.note.posted"));
});

it("card: a failed post shows the host detail", async () => {
  const c = mount(() => NoteCard({ note: note(), onEdit: vi.fn(), onDelete: vi.fn(), onPostToPr: () => Promise.reject({ code: "gh_failed", detail: "422 Unprocessable" }) }));
  c.find((x) => "data-post-pr" in x.props)!.props.onClick();
  await tick();
  const html = c.html();
  expect(html).toContain("422 Unprocessable");
  expect(html).toContain(en("review.note.postToPr"));
});

it("card: an outdated note never offers Post on PR", () => {
  const html = mount(() => NoteCard({ note: note({ outdated: true }), onEdit: vi.fn(), onDelete: vi.fn(), onPostToPr: async () => {}, postBlocked: null })).html();
  expect(html).not.toContain(en("review.note.postToPr"));
});

it("card: a blocked note shows Post on PR disabled with the reason, and never posts", async () => {
  const post = vi.fn(async () => {});
  const c = mount(() => NoteCard({ note: note(), onEdit: vi.fn(), onDelete: vi.fn(), onPostToPr: post, postBlocked: "push" }));
  const button = c.find((x) => "data-post-pr" in x.props)!;
  expect(button.props.disabled).toBe(true);
  button.props.onClick();
  await tick();
  expect(post).not.toHaveBeenCalled();
  expect(c.html()).toContain(en("review.note.postBlocked.push"));
});

it("card: an unread PR head says so", () => {
  const html = mount(() => NoteCard({ note: note(), onEdit: vi.fn(), onDelete: vi.fn(), onPostToPr: async () => {}, postBlocked: "unknown" })).html();
  expect(html).toContain(en("review.note.postBlocked.unknown"));
});
