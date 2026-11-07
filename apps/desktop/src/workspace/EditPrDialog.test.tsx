import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Segmented } from "@xdev-asia/ui";
import { createMockApi, type Api, type PrDetail } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { EditPrDialog } from "./EditPrDialog";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
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
const DETAIL: PrDetail = {
  number: 7, url: "https://example.test/pull/7", state: "open", title: "Fix", body: "Old **body**", author: "ada", base: "main", head: "oak",
  reviewDecision: null, mergeable: "mergeable", mergeState: "clean", reviewers: [], entries: [], files: [], autoMerge: null,
};

function seeded(): Api {
  return createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prDetails: { [OAK]: structuredClone(DETAIL) } } });
}

function mount(api: Api) {
  const values: unknown[] = [];
  const saved = vi.fn();
  const closed = vi.fn();
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return EditPrDialog({ api, worktree: OAK, number: 7, title: DETAIL.title, body: DETAIL.body, onSaved: saved, onClose: closed }); } finally { hooks.active = false; }
  };
  draw();
  return { all: () => nodes(draw()), html: () => renderToStaticMarkup(draw()), saved, closed };
}
const input = (view: ReturnType<typeof mount>) => view.all().find((n) => n.type === "input")!;
const area = (view: ReturnType<typeof mount>) => view.all().find((n) => n.type === "textarea")!;
const submit = (view: ReturnType<typeof mount>) => view.all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => { vi.restoreAllMocks(); });

it("opens on the current title and body with one primary button, Save", () => {
  const view = mount(seeded());
  expect(input(view).props.value).toBe("Fix");
  expect(area(view).props.value).toBe("Old **body**");
  expect(view.html()).toContain(en("prPanel.edit.title", { number: 7 }));
  const buttons = view.all().filter((n) => n.type === Button);
  expect(buttons.filter((b) => b.props.variant === "primary").map((b) => b.props.children)).toEqual([en("prPanel.edit.save")]);
  expect(buttons.every((b) => b.props.type === "submit" || b.props.type === "button")).toBe(true);
});

it("the preview renders the body as markdown without raw HTML", () => {
  const view = mount(seeded());
  area(view).props.onChange({ target: { value: "New **text**\n\n<script>x</script>" } });
  view.all().find((n) => n.type === Segmented)!.props.onChange("preview");
  const html = view.html();
  expect(html).toContain("<strong>text</strong>");
  expect(html).not.toContain("<script>");
  expect(view.all().some((n) => n.type === "textarea")).toBe(false);
});

it("Save sends the trimmed title and the body, then reports it saved", async () => {
  const api = seeded();
  const edit = vi.spyOn(api, "worktreePrEdit");
  const view = mount(api);
  input(view).props.onChange({ target: { value: "  Better title " } });
  area(view).props.onChange({ target: { value: "New body" } });
  submit(view);
  await tick();
  expect(edit).toHaveBeenCalledWith(OAK, 7, "Better title", "New body");
  expect(view.saved).toHaveBeenCalledTimes(1);
  expect((await api.worktreePrDetail(OAK))?.title).toBe("Better title");
});

it("an empty title cannot be saved", () => {
  const api = seeded();
  const edit = vi.spyOn(api, "worktreePrEdit");
  const view = mount(api);
  input(view).props.onChange({ target: { value: "   " } });
  expect(view.all().find((n) => n.type === Button && n.props.type === "submit")!.props.disabled).toBe(true);
  submit(view);
  expect(edit).not.toHaveBeenCalled();
});

it("a failure stays open and shows the reason", async () => {
  const api = seeded();
  vi.spyOn(api, "worktreePrEdit").mockRejectedValue({ code: "gh_failed", detail: "HTTP 422" });
  const view = mount(api);
  submit(view);
  await tick();
  expect(view.saved).not.toHaveBeenCalled();
  expect(view.html()).toContain("HTTP 422");
});
