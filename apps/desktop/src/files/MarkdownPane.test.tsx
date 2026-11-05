import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Segmented } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { MarkdownPane } from "./MarkdownPane";
import { MarkdownPreview } from "./MarkdownPreview";
import { markdownMode } from "./markdownMode";
import { onOpenFile } from "./openFile";

const hooks = vi.hoisted(() => ({ active: false }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (e: any, d?: any) => (hooks.active ? undefined : react.useEffect(e, d)),
    useMemo: (f: any, d: any) => (hooks.active ? f() : react.useMemo(f, d)),
    useRef: (v: any) => (hooks.active ? { current: v } : react.useRef(v)),
    useState: (i: any) => (hooks.active ? [typeof i === "function" ? i() : i, () => {}] : react.useState(i)),
    useSyncExternalStore: (s: any, g: any, sv?: any) => (hooks.active ? g() : react.useSyncExternalStore(s, g, sv)),
  };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const W = "C:/wt/a";
const api = createMockApi({});
const run = <T,>(f: () => T): T => {
  hooks.active = true;
  try {
    return f();
  } finally {
    hooks.active = false;
  }
};
const pane = () => run(() => nodes(MarkdownPane({ api, worktree: W, rel: "docs/a.md", text: "# Hi\n\nunsaved", source: <i id="editor" /> })));

beforeEach(() => markdownMode.reset());
afterEach(() => markdownMode.reset());

it("opens on Source with a Source and Preview toggle", () => {
  const list = pane();
  const toggle = list.find((n) => n.type === Segmented)!;
  expect(toggle.props.value).toBe("source");
  expect(toggle.props.options.map((o: any) => o.label)).toEqual(["Source", "Preview"]);
  expect(list.some((n) => n.props.id === "editor")).toBe(true);
  expect(list.some((n) => n.type === MarkdownPreview)).toBe(false);
});

it("shows the preview of the unsaved text after the toggle, and the editor again after toggling back", () => {
  pane().find((n) => n.type === Segmented)!.props.onChange("preview");
  const list = pane();
  expect(list.find((n) => n.type === MarkdownPreview)!.props.text).toBe("# Hi\n\nunsaved");
  expect(list.some((n) => n.props.id === "editor")).toBe(false);
  list.find((n) => n.type === Segmented)!.props.onChange("source");
  expect(pane().some((n) => n.props.id === "editor")).toBe(true);
});

const preview = (text: string) => run(() => nodes(MarkdownPreview({ api, worktree: W, rel: "docs/a.md", text })));

it("renders the text as HTML", () => {
  const body = preview("# Title\n\n> [!NOTE]\n> hello").find((n) => n.props.dangerouslySetInnerHTML)!;
  const html = body.props.dangerouslySetInnerHTML.__html as string;
  expect(html).toContain('<h1 id="title">');
  expect(html).toContain("md-callout-note");
});

it("a relative link opens that file; a click elsewhere does nothing", () => {
  const seen: unknown[] = [];
  const off = onOpenFile((r) => seen.push(r));
  const article = preview("[b](b.md)").find((n) => n.type === "article")!;
  // The handler checks `instanceof Element`, which this environment lacks, so give it a stand-in class.
  class FakeElement {
    constructor(private doc: string | null) {}
    closest() {
      return this.doc ? { getAttribute: () => this.doc } : null;
    }
  }
  vi.stubGlobal("Element", FakeElement);
  article.props.onClick({ target: new FakeElement("docs/b.md"), preventDefault() {} });
  article.props.onClick({ target: new FakeElement(null), preventDefault() {} });
  vi.unstubAllGlobals();
  off();
  expect(seen).toEqual([{ worktree: W, rel: "docs/b.md" }]);
});
