import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type ApiError, type IssueDetail } from "@/api";
import { translate } from "@/i18n";
import { IssueDetailView } from "./IssueDetailView";

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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Draws with its own hook values; each draw's effects run as after a commit.
function mount(api: Api, number: number, handlers: { onBack?: () => void; onStart?: (d: IssueDetail) => void } = {}) {
  const values: unknown[] = [];
  const cleanups: (void | (() => void))[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return IssueDetailView({ api, repoId: "r1", number, onBack: handlers.onBack ?? (() => {}), onStart: handlers.onStart }); } finally { hooks.active = false; }
  };
  const commit = () => {
    cleanups.splice(0).forEach((c) => typeof c === "function" && c());
    const before = hooks.effects.length;
    const tree = draw();
    cleanups.push(...hooks.effects.slice(before).map((effect) => effect()));
    return tree;
  };
  return { commit, nodes: () => nodes(draw()), html: () => renderToStaticMarkup(draw()) };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => { vi.restoreAllMocks(); });

const button = (view: ReturnType<typeof mount>, label: string) => view.nodes().find((n) => n.type === "button" && n.props.children === label);

it("loads, then shows state, markdown body and comments", async () => {
  const view = mount(createMockApi({}), 1);
  view.commit();
  expect(view.html()).toContain(en("issues.loading"));
  await flush();
  const html = view.html();
  expect(html).toContain("#1");
  expect(html).toContain(en("issues.state.open"));
  expect(html).toContain("<li>open a narrow window</li>");
  expect(html).toContain("<strong>Thanks</strong>");
  expect(html).toContain(en("issues.comments", { count: 1 }));
  expect(html).toContain("octocat");
});

it("escapes raw HTML in a body", async () => {
  const api = createMockApi({});
  const detail = await api.issueView("r1", 1);
  const view = mount({ ...api, issueView: async () => ({ ...detail, body: "<img src=x onerror=alert(1)>" }) } as Api, 1);
  view.commit();
  await flush();
  expect(view.html()).not.toContain("<img");
});

it("says so when the issue has no description", async () => {
  const view = mount(createMockApi({}), 2);
  view.commit();
  await flush();
  expect(view.html()).toContain(en("issues.noBody"));
});

it("back calls onBack", () => {
  const onBack = vi.fn();
  const view = mount(createMockApi({}), 1, { onBack });
  view.commit();
  button(view, en("issues.back"))!.props.onClick();
  expect(onBack).toHaveBeenCalledOnce();
});

it("open on GitHub asks the api to open the issue", async () => {
  const api = createMockApi({});
  const issueOpen = vi.fn(async () => {});
  const view = mount({ ...api, issueOpen } as Api, 1);
  view.commit();
  await button(view, en("issues.openWeb"))!.props.onClick();
  expect(issueOpen).toHaveBeenCalledWith("r1", 1);
});

it("start worktree hands the loaded issue over, and is absent without a handler", async () => {
  const onStart = vi.fn();
  const withStart = mount(createMockApi({}), 1, { onStart });
  withStart.commit();
  expect(button(withStart, en("issues.start"))).toBeUndefined();
  await flush();
  button(withStart, en("issues.start"))!.props.onClick();
  expect(onStart.mock.calls[0][0].issue.number).toBe(1);
  const without = mount(createMockApi({}), 1);
  without.commit();
  await flush();
  expect(button(without, en("issues.start"))).toBeUndefined();
});

it("shows a missing issue as an error", async () => {
  const view = mount(createMockApi({}), 99);
  view.commit();
  await flush();
  expect(view.html()).toContain(en("error.issue_not_found"));
});

it("explains a gh failure with its hint", async () => {
  const err = { code: "gh_auth", message: "", detail: null } as unknown as ApiError;
  const view = mount({ ...createMockApi({}), issueView: () => Promise.reject(err) } as Api, 1);
  view.commit();
  await flush();
  expect(view.html()).toContain(en("issues.reason.gh_auth"));
});
