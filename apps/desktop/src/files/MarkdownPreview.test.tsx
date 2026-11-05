import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Dialog, PanZoom, ZoomBar } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { MarkdownPreview } from "./MarkdownPreview";
import { MermaidDialog } from "./MermaidDialog";
import { fillMermaid, mermaidTheme, type MermaidLabels } from "./mermaid";

const hooks = vi.hoisted(() => ({ active: false, deps: [] as unknown[][], effects: [] as Array<() => unknown>, host: undefined as unknown }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (e: any, d?: any) => (hooks.active ? void (hooks.deps.push(d ?? []), hooks.effects.push(e)) : react.useEffect(e, d)),
    useMemo: (f: any, d: any) => (hooks.active ? f() : react.useMemo(f, d)),
    useRef: (v: any) => (hooks.active ? { current: v === null && hooks.host ? hooks.host : v } : react.useRef(v)),
    useState: (i: any) => (hooks.active ? [typeof i === "function" ? i() : i, () => {}] : react.useState(i)),
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
const run = <T,>(f: () => T): T => {
  hooks.active = true;
  try {
    return f();
  } finally {
    hooks.active = false;
  }
};
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const labels: MermaidLabels = { invalid: "Invalid mermaid syntax", error: (m) => `Diagram error: ${m}`, expand: "Expand diagram" };
const slot = (src: string) => ({ innerHTML: "", getAttribute: (n: string) => (n === "data-src" ? src : null) });

it("a mermaid fence becomes a placeholder the preview fills after mount", () => {
  const body = run(() => nodes(MarkdownPreview({ api: createMockApi({}), worktree: "C:/wt/a", rel: "a.md", text: "```mermaid\ngraph TD; A-->B\n```" }))).find((n) => n.props.dangerouslySetInnerHTML)!;
  expect(body.props.dangerouslySetInnerHTML.__html).toContain('class="md-mermaid" data-src="graph TD; A--&gt;B\n"');
});

it("draws each placeholder with the injected renderer and adds an expand button", async () => {
  const a = slot("graph TD; A-->B");
  const render = vi.fn(async () => "<svg></svg>");
  fillMermaid({ querySelectorAll: () => [a] }, { render, theme: { lineColor: "x" }, labels });
  await tick();
  expect(render).toHaveBeenCalledWith(expect.stringMatching(/^md-mermaid-\d+$/), "graph TD; A-->B", { lineColor: "x" });
  expect(a.innerHTML).toContain("<svg></svg>");
  expect(a.innerHTML).toContain('type="button" class="btn-secondary md-mermaid-expand">Expand diagram<');
});

it("bad syntax shows the invalid state and the message, escaped", async () => {
  const a = slot("nonsense");
  fillMermaid({ querySelectorAll: () => [a] }, { render: async () => Promise.reject(new Error("Parse <error>")), theme: {}, labels });
  await tick();
  expect(a.innerHTML).toContain("Invalid mermaid syntax");
  expect(a.innerHTML).toContain("Diagram error: Parse &lt;error&gt;");
  expect(a.innerHTML).not.toContain("<error>");
});

it("drops a diagram that arrives after cleanup", async () => {
  const a = slot("x");
  let done!: (s: string) => void;
  const stop = fillMermaid({ querySelectorAll: () => [a] }, { render: () => new Promise<string>((r) => (done = r)), theme: {}, labels });
  stop();
  done("<svg></svg>");
  await tick();
  expect(a.innerHTML).toBe("");
});

it("takes the theme from CSS variables and skips empty ones", () => {
  const theme = mermaidTheme((n) => ({ "--x-color-ink": " #111 ", "--x-color-line": "" })[n] ?? "");
  expect(theme).toEqual({ primaryTextColor: "#111", textColor: "#111" });
});

it("the expanded diagram is a wide dialog titled Diagram with zoom and pan", () => {
  const onClose = vi.fn();
  const list = run(() => nodes(MermaidDialog({ svg: "<svg></svg>", onClose })));
  const dialog = list.find((n) => n.type === Dialog)!;
  expect(dialog.props).toMatchObject({ title: "Diagram", size: "wide", cancelLabel: null });
  expect(list.some((n) => n.type === ZoomBar)).toBe(true);
  expect(list.find((n) => n.type === PanZoom)!.props).toMatchObject({ zoom: 1, x: 0, y: 0 });
  expect(list.find((n) => n.props.dangerouslySetInnerHTML)!.props.dangerouslySetInnerHTML.__html).toBe("<svg></svg>");
  dialog.props.onConfirm();
  expect(onClose).toHaveBeenCalled();
});

it("the image effect is keyed on the html, so a rerender with the same html keeps its images", () => {
  const api = createMockApi({});
  const deps = () => {
    hooks.deps = [];
    run(() => MarkdownPreview({ api, worktree: "C:/wt/a", rel: "a.md", text: "![a](p.png)" }));
    return hooks.deps.find((d) => d.includes("C:/wt/a"))!;
  };
  const first = deps();
  const second = deps();
  expect(typeof first[0]).toBe("string");
  expect(first[0]).toContain("md-image");
  expect(second[0]).toBe(first[0]);
  // No dependency is the rendered result itself: that is a new object on every render.
  expect(first.some((d) => typeof d === "object" && d !== null && "html" in d)).toBe(false);
});

const host = () => ({ querySelectorAll: vi.fn(() => []), getAttribute: () => null });
const effectsOf = (props: Partial<Parameters<typeof MarkdownPreview>[0]>, el: ReturnType<typeof host>) => {
  hooks.effects = [];
  hooks.deps = [];
  hooks.host = el;
  try {
    run(() => MarkdownPreview({ api: createMockApi({}), worktree: "C:/wt/a", rel: "a.md", text: "![a](p.png)", ...props }));
  } finally {
    hooks.host = undefined;
  }
  return hooks.effects;
};

it("a hidden preview reads no images and draws no diagrams; a shown one looks for its placeholders", () => {
  const hidden = host();
  for (const effect of effectsOf({ hidden: true }, hidden)) effect();
  expect(hidden.querySelectorAll).not.toHaveBeenCalled();
  const shown = host();
  // The images effect is the one keyed on the worktree; the diagram effect needs a real page.
  const effects = effectsOf({ hidden: false }, shown);
  effects[hooks.deps.findIndex((d) => d.includes("C:/wt/a"))]();
  expect(shown.querySelectorAll).toHaveBeenCalledWith(".md-image[data-src]");
});

it("the image and diagram effects wake up when the preview is shown", () => {
  hooks.deps = [];
  run(() => MarkdownPreview({ api: createMockApi({}), worktree: "C:/wt/a", rel: "a.md", text: "x", hidden: true }));
  const hiddenDeps = hooks.deps.filter((d) => d.includes(true));
  hooks.deps = [];
  run(() => MarkdownPreview({ api: createMockApi({}), worktree: "C:/wt/a", rel: "a.md", text: "x", hidden: false }));
  // The debounce, the images and the diagrams all depend on it.
  expect(hiddenDeps).toHaveLength(3);
  expect(hooks.deps.filter((d) => d.includes(false))).toHaveLength(3);
});
