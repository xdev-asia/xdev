import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev/ui";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { CreatePrDialog } from "./CreatePrDialog";

// Hooks are stubbed only while a component under test is called; each harness keeps its own.
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


const INITIAL = { base: "main", title: "", body: "", draft: false };

type Extra = Partial<Parameters<typeof CreatePrDialog>[0]>;

function dialog(api: Api, extra: Extra = {}) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const view = mount(() => CreatePrDialog({ api, worktree: OAK, initial: INITIAL, onCreated, onClose, ...extra }));
  const inputs = () => view.all().filter((n) => n.type === "input");
  const base = () => inputs()[0];
  const title = () => inputs()[1];
  const draft = () => inputs()[2];
  const body = () => view.find((n) => n.type === "textarea")!;
  const create = () => view.find((n) => n.type === Button)!;
  const agent = () => view.find((n) => n.type === "button" && n.props.children === en("ship.pr.agent"))!;
  const agentBusy = () => view.find((n) => n.type === "button" && n.props.children === en("ship.pr.agentBusy"));
  const submit = () => view.find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  return { ...view, onCreated, onClose, base, title, draft, body, create, agent, agentBusy, submit };
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
});
afterEach(() => { vi.restoreAllMocks(); });

it("draft with agent fills title and body", async () => {
  const api = createMockApi({});
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  const view = dialog(api);
  view.agent().props.onClick();
  // Busy while the agent writes.
  expect(view.html()).toContain(en("ship.pr.agentBusy"));
  await tick();
  expect(view.title().props.value).toBe("feat: one");
  expect(view.body().props.value).toBe("Changes from oak.");
  expect(view.create().props.disabled).toBe(false);
});

it("creates a draft PR and reports it", async () => {
  const api = createMockApi({});
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  await api.worktreePush(OAK);
  const create = vi.spyOn(api, "worktreePrCreate");
  const view = dialog(api);
  view.title().props.onChange({ target: { value: "  Add session  " } });
  view.body().props.onChange({ target: { value: "Why" } });
  view.draft().props.onChange();
  view.submit();
  await tick();
  expect(create).toHaveBeenCalledWith(OAK, { base: "main", title: "Add session", body: "Why", draft: true });
  expect(view.onCreated).toHaveBeenCalledWith(expect.objectContaining({ title: "Add session", state: "draft" }));
});

it("empty title keeps create disabled", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "worktreePrCreate");
  const view = dialog(api);
  expect(view.create().props.disabled).toBe(true);
  view.title().props.onChange({ target: { value: "   " } });
  expect(view.create().props.disabled).toBe(true);
  view.submit();
  await tick();
  expect(create).not.toHaveBeenCalled();
  view.title().props.onChange({ target: { value: "x" } });
  expect(view.create().props.disabled).toBe(false);
});

it("shows a refused create by its code", async () => {
  const api = createMockApi({});
  const view = dialog(api);
  view.title().props.onChange({ target: { value: "x" } });
  view.submit();
  await tick();
  expect(view.html()).toContain(en("error.not_pushed"));
  expect(view.onCreated).not.toHaveBeenCalled();
});

it("shows the detail of a gh failure", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreePrCreate").mockRejectedValue({ code: "gh_failed", detail: "boom happened" });
  const view = dialog(api);
  view.title().props.onChange({ target: { value: "x" } });
  view.submit();
  await tick();
  expect(view.html()).toContain("boom happened");
});

it("starts from the draft default and drafts with the agent on open when asked", async () => {
  const api = createMockApi({});
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  const drafting = vi.spyOn(api, "worktreeDraftPr");
  const view = dialog(api, { initial: { ...INITIAL, draft: true }, generateOnOpen: true });
  expect(view.draft().props.checked).toBe(true);
  expect(drafting).toHaveBeenCalledOnce();
  expect(view.agentBusy()).toBeDefined();
  await tick();
  expect(view.title().props.value).toBe("feat: one");
});

it("hides the agent and never drafts on open without the agent actions", async () => {
  const api = createMockApi({});
  const drafting = vi.spyOn(api, "worktreeDraftPr");
  const view = dialog(api, { ai: false, generateOnOpen: true });
  expect(view.html()).not.toContain(en("ship.pr.agent"));
  expect(drafting).not.toHaveBeenCalled();
});

it("opens the new pull request in the browser when asked", async () => {
  const api = createMockApi({});
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  await api.worktreePush(OAK);
  const open = vi.spyOn(api, "worktreePrOpen").mockRejectedValue({ code: "io" });
  const view = dialog(api, { openAfterCreate: true });
  view.title().props.onChange({ target: { value: "Add session" } });
  view.submit();
  await tick();
  expect(open).toHaveBeenCalledWith(OAK, false);
  // A browser that fails to open does not undo the create.
  expect(view.onCreated).toHaveBeenCalledOnce();
  expect(view.html()).not.toContain(en("error.io"));
});
