import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type PrQuery } from "@/api";
import { translate } from "@/i18n";
import { IssuesPanel, SEARCH_DEBOUNCE_MS } from "./IssuesPanel";
import { NewIssueForm } from "./NewIssueForm";
import { chipQuery, PrsList } from "./PrsList";
import { ProjectsList } from "./ProjectsList";

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

// Draws with its own hook values; each commit runs that draw's effects as after a commit.
function mount(component: () => ReactElement) {
  const values: unknown[] = [];
  const cleanups: (void | (() => void))[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return component(); } finally { hooks.active = false; }
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

const prQueries = (api: Api) => {
  const queries: PrQuery[] = [];
  const list = api.prsList.bind(api);
  return { queries, api: { ...api, prsList: (id: string, q: PrQuery) => { queries.push(q); return list(id, q); } } as Api };
};

it("maps each chip to its pull request query", () => {
  expect(chipQuery("open", null)).toMatchObject({ state: "open", mine: false, needsReview: false });
  expect(chipQuery("mine", null)).toMatchObject({ mine: true, needsReview: false });
  expect(chipQuery("review", "x")).toMatchObject({ needsReview: true, search: "x" });
});

it("the panel shows the three views and switches to pull requests", () => {
  const view = mount(() => IssuesPanel({ api: createMockApi({}), repoId: "r1" }));
  view.commit();
  const seg = view.nodes().find((n) => n.props.label === en("issues.view.label"))!;
  expect(seg.props.options.map((o: { value: string }) => o.value)).toEqual(["issues", "prs", "projects"]);
  seg.props.onChange("prs");
  expect(view.nodes().some((n) => n.type === PrsList)).toBe(true);
  expect(SEARCH_DEBOUNCE_MS).toBeGreaterThan(0);
});

it("lists pull requests and asks again for the other chips", async () => {
  const { api, queries } = prQueries(createMockApi({}));
  const view = mount(() => PrsList({ api, repoId: "r1", searchDebounceMs: SEARCH_DEBOUNCE_MS }));
  view.commit();
  expect(view.html()).toContain(en("issues.prs.loading"));
  await flush();
  const html = view.html();
  expect(html).toContain("#10");
  expect(html).toContain("#11");
  view.nodes().find((n) => n.props.children === en("issues.prs.chip.mine"))!.props.onClick();
  view.commit();
  expect(queries.at(-1)).toMatchObject({ mine: true });
  view.nodes().find((n) => n.props.children === en("issues.prs.chip.review"))!.props.onClick();
  view.commit();
  expect(queries.at(-1)).toMatchObject({ needsReview: true, mine: false });
});

it("a pull request row opens through prOpen", async () => {
  const api = createMockApi({});
  const open = vi.spyOn(api, "prOpen");
  const view = mount(() => PrsList({ api, repoId: "r1", searchDebounceMs: SEARCH_DEBOUNCE_MS }));
  view.commit();
  await flush();
  view.nodes().find((n) => n.props.className === "ws-issue-open")!.props.onClick();
  expect(open).toHaveBeenCalledWith("r1", expect.any(Number));
});

it("shows the sign-in reason when gh is not signed in", async () => {
  const api = { ...createMockApi({}), prsList: () => Promise.reject({ code: "gh_auth" }) } as unknown as Api;
  const view = mount(() => PrsList({ api, repoId: "r1", searchDebounceMs: SEARCH_DEBOUNCE_MS }));
  view.commit();
  await flush();
  expect(view.html()).toContain(en("issues.reason.gh_auth"));
});

it("lists projects with a closed badge and shows the scope line", async () => {
  const api = createMockApi({});
  const view = mount(() => ProjectsList({ api, repoId: "r1" }));
  view.commit();
  await flush();
  const html = view.html();
  expect(html).toContain("#1");
  expect(html).toContain(en("issues.projects.closed"));
  const scoped = { ...api, projectsList: () => Promise.reject({ code: "gh_scope" }) } as unknown as Api;
  const failing = mount(() => ProjectsList({ api: scoped, repoId: "r1" }));
  failing.commit();
  await flush();
  expect(failing.html()).toContain(en("error.gh_scope"));
});

it("a blank title cannot be sent; a title creates the issue and hands it back", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "issueCreate");
  const onCreated = vi.fn();
  const view = mount(() => NewIssueForm({ api, repoId: "r1", onCreated, onCancel: vi.fn() }));
  view.commit();
  const submit = () => view.nodes().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  const button = () => view.nodes().find((n) => n.props.type === "submit")!;
  expect(button().props.disabled).toBe(true);
  submit();
  expect(create).not.toHaveBeenCalled();
  view.nodes().find((n) => n.type === "input")!.props.onChange({ target: { value: "  Footer is cut  " } });
  view.commit();
  expect(button().props.disabled).toBe(false);
  submit();
  await flush();
  expect(create).toHaveBeenCalledWith("r1", { title: "Footer is cut", body: "" });
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ title: "Footer is cut" }));
});
