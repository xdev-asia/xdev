import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type ApiError, type IssueQuery } from "@/api";
import { translate } from "@/i18n";
import { IssueDetailView } from "./IssueDetailView";
import { IssuesPanel, SEARCH_DEBOUNCE_MS } from "./IssuesPanel";

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
function mount(api: Api) {
  const values: unknown[] = [];
  const cleanups: (void | (() => void))[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return IssuesPanel({ api, repoId: "r1" }); } finally { hooks.active = false; }
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function spied(overrides: Partial<Api> = {}) {
  const api = createMockApi({});
  const queries: IssueQuery[] = [];
  const list = api.issuesList.bind(api);
  return { queries, api: { ...api, issuesList: (id: string, q: IssueQuery) => { queries.push(q); return list(id, q); }, ...overrides } as Api };
}

it("shows loading, then one row per open issue", async () => {
  const { api } = spied();
  const view = mount(api);
  view.commit();
  expect(view.html()).toContain(en("issues.loading"));
  await flush();
  const html = view.html();
  expect(html).toContain("#1");
  expect(html).toContain(">ui<");
  expect(html).not.toContain(en("issues.loading"));
  expect(html).not.toContain("data-state=\"closed\"");
});

it("asks for closed issues and for mine when toggled", async () => {
  const { api, queries } = spied();
  const view = mount(api);
  view.commit();
  await flush();
  const buttons = view.nodes().filter((n) => n.type === "button");
  buttons.find((b) => b.props.children === en("issues.state.closed"))!.props.onClick();
  view.commit();
  await flush();
  expect(queries.at(-1)).toMatchObject({ state: "closed", assigneeMe: false });
  view.nodes().find((n) => n.type === "input" && n.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
  view.commit();
  expect(queries.at(-1)).toMatchObject({ assigneeMe: true });
});

it("searches only after the debounce", async () => {
  const { api, queries } = spied();
  const view = mount(api);
  view.commit();
  await flush();
  vi.useFakeTimers();
  view.nodes().find((n) => n.type === "input" && n.props.type === "search")!.props.onChange({ target: { value: "meter" } });
  view.commit();
  expect(queries.every((q) => q.search === null)).toBe(true);
  vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  view.commit();
  expect(queries.at(-1)?.search).toBe("meter");
});

it("refresh asks again", async () => {
  const { api, queries } = spied();
  const view = mount(api);
  view.commit();
  await flush();
  const before = queries.length;
  view.nodes().find((n) => n.type === "button" && n.props.children === en("issues.refresh"))!.props.onClick();
  view.commit();
  expect(queries.length).toBe(before + 1);
});

it("says nothing matches for an empty list", async () => {
  const { api } = spied({ issuesList: async () => [] });
  const view = mount(api);
  view.commit();
  await flush();
  expect(view.html()).toContain(en("issues.empty"));
});

it.each([
  ["gh_missing", "issues.reason.gh_missing"],
  ["gh_auth", "issues.reason.gh_auth"],
  ["not_github", "issues.reason.not_github"],
  ["gh_failed", "error.gh_failed"],
])("explains %s", async (code, key) => {
  const err: ApiError = { code, message: "", detail: null } as unknown as ApiError;
  const { api } = spied({ issuesList: () => Promise.reject(err) });
  const view = mount(api);
  view.commit();
  await flush();
  const html = view.html();
  expect(html).toContain('role="alert"');
  expect(html).toContain(en(key).replace(/'/g, "&#x27;"));
});

it("opens the detail of a clicked row and comes back", async () => {
  const { api } = spied();
  const view = mount(api);
  view.commit();
  await flush();
  view.nodes().find((n) => n.type === "button" && n.props.className === "ws-issue-open")!.props.onClick();
  const detail = view.nodes()[0];
  expect(detail.type).toBe(IssueDetailView);
  expect(detail.props).toMatchObject({ repoId: "r1", number: 1 });
  detail.props.onBack();
  expect(view.nodes()[0].type).not.toBe(IssueDetailView);
});
