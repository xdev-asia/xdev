import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type ApiError, type IssueDetail } from "@/api";
import { Button, Field, Menu, Popover, Textarea } from "@xdev-asia/ui";
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

// ---- edit: state, labels, assignees ----
const popover = (view: ReturnType<typeof mount>, label: string) => view.nodes().find((n) => n.type === Popover && n.props.label === label)!;
const menuItems = (node: Node) => nodes(node).find((n) => n.type === Menu)!.props.items as { label: string; checked?: boolean; onSelect?: () => void }[];

it("renders the state, labels and assignees controls once loaded", async () => {
  const view = mount(createMockApi({}), 1);
  view.commit();
  expect(view.nodes().some((n) => n.type === Popover)).toBe(false);
  await flush();
  for (const key of ["issues.edit.close", "issues.edit.labels", "issues.edit.assignees"]) expect(popover(view, en(key))).toBeTruthy();
  const html = view.html();
  expect(html).toContain("bug");
  expect(html).toContain("me");
});

it("closing as not planned sends the state edit and reloads", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(api.issueEdit);
  const issueView = vi.fn(api.issueView);
  const view = mount({ ...api, issueEdit, issueView } as Api, 1);
  view.commit();
  await flush();
  const items = menuItems(popover(view, en("issues.edit.close")));
  expect(items.map((i) => i.label)).toEqual([en("issues.edit.closeCompleted"), en("issues.edit.closeNotPlanned")]);
  items[1].onSelect!();
  await flush();
  expect(issueEdit).toHaveBeenCalledOnce();
  expect(issueEdit.mock.calls[0][2]).toMatchObject({ state: "closed", closeReason: "not_planned" });
  expect(issueView).toHaveBeenCalledTimes(2);
  expect(view.html()).toContain(en("issues.state.closed"));
  expect(button(view, en("issues.edit.reopen"))).toBeTruthy();
});

it("a labels pick is saved as a diff when the picker closes", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(api.issueEdit);
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  popover(view, en("issues.edit.labels")).props.trigger({})!.props.onClick();
  await flush();
  const items = menuItems(popover(view, en("issues.edit.labels")));
  expect(items.map((i) => [i.label, i.checked])).toEqual([["bug", true], ["docs", false], ["ui", true]]);
  items.find((i) => i.label === "docs")!.onSelect!();
  menuItems(popover(view, en("issues.edit.labels"))).find((i) => i.label === "bug")!.onSelect!();
  popover(view, en("issues.edit.labels")).props.onClose();
  await flush();
  expect(issueEdit.mock.calls[0][2]).toMatchObject({ addLabels: ["docs"], removeLabels: ["bug"] });
});

it("closing a picker without a change sends nothing", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(api.issueEdit);
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  popover(view, en("issues.edit.assignees")).props.trigger({})!.props.onClick();
  await flush();
  popover(view, en("issues.edit.assignees")).props.onClose();
  await flush();
  expect(issueEdit).not.toHaveBeenCalled();
});

it("an assignee pick uses the assignable logins", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(api.issueEdit);
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  popover(view, en("issues.edit.assignees")).props.trigger({})!.props.onClick();
  await flush();
  const items = menuItems(popover(view, en("issues.edit.assignees")));
  expect(items.map((i) => i.label)).toEqual(["octo", "mona", "me"]);
  items[0].onSelect!();
  popover(view, en("issues.edit.assignees")).props.onClose();
  await flush();
  expect(issueEdit.mock.calls[0][2]).toMatchObject({ addAssignees: ["octo"], removeAssignees: [] });
});

it("a partial report shows what was not saved", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(async () => ({ failed: ["state"], error: "boom" }));
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  menuItems(popover(view, en("issues.edit.close")))[0].onSelect!();
  await flush();
  const html = view.html();
  expect(html).toContain(en("issues.edit.partial", { parts: en("issues.edit.part.state") }));
  expect(html).toContain("boom");
});

it("an edit that rejects shows its error", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(() => Promise.reject({ code: "bad_draft", message: "", detail: null }));
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  menuItems(popover(view, en("issues.edit.close")))[0].onSelect!();
  await flush();
  expect(view.html()).toContain(en("error.bad_draft"));
});

// ---- edit: title, body, comment ----
const findBtn = (view: ReturnType<typeof mount>, label: string) => view.nodes().find((n) => (n.type === "button" || n.type === Button) && n.props.children === label)!;

it("saving a body edit sends the body only", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(api.issueEdit);
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  findBtn(view, en("issues.edit.body")).props.onClick();
  const area = view.nodes().find((n) => n.type === Textarea)!;
  expect(area.props.value).toContain("narrow window");
  area.props.onChange({ target: { value: "New text" } });
  findBtn(view, en("issues.edit.save")).props.onClick();
  await flush();
  const sent = issueEdit.mock.calls[0][2];
  expect(sent.body).toBe("New text");
  expect(sent.title).toBeNull();
  expect(view.html()).toContain("<p>New text</p>");
});

it("a blank title cannot be saved, and an unchanged one sends nothing", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(api.issueEdit);
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  findBtn(view, en("issues.edit.title")).props.onClick();
  view.nodes().find((n) => n.type === Field)!.props.onChange({ target: { value: "  " } });
  expect(findBtn(view, en("issues.edit.save")).props.disabled).toBe(true);
  view.nodes().find((n) => n.type === Field)!.props.onChange({ target: { value: "Footer meter overflows" } });
  findBtn(view, en("issues.edit.save")).props.onClick();
  await flush();
  expect(issueEdit).not.toHaveBeenCalled();
});

it("cancel closes the editor without sending", async () => {
  const api = createMockApi({});
  const issueEdit = vi.fn(api.issueEdit);
  const view = mount({ ...api, issueEdit } as Api, 1);
  view.commit();
  await flush();
  findBtn(view, en("issues.edit.title")).props.onClick();
  findBtn(view, en("issues.edit.cancel")).props.onClick();
  expect(view.nodes().some((n) => n.type === Field)).toBe(false);
  expect(issueEdit).not.toHaveBeenCalled();
});

it("an empty comment disables Comment; posting reloads and clears the box", async () => {
  const api = createMockApi({});
  const issueComment = vi.fn(api.issueComment);
  const view = mount({ ...api, issueComment } as Api, 1);
  view.commit();
  await flush();
  expect(findBtn(view, en("issues.comment.post")).props.disabled).toBe(true);
  view.nodes().find((n) => n.type === Textarea && n.props.label === en("issues.comment.placeholder"))!.props.onChange({ target: { value: "Hello" } });
  expect(findBtn(view, en("issues.comment.post")).props.disabled).toBe(false);
  findBtn(view, en("issues.comment.post")).props.onClick();
  await flush();
  expect(issueComment).toHaveBeenCalledWith("r1", 1, "Hello");
  expect(view.html()).toContain(en("issues.comments", { count: 2 }));
  expect(findBtn(view, en("issues.comment.post")).props.disabled).toBe(true);
});

it("a failed comment keeps the text and shows the error", async () => {
  const api = createMockApi({});
  const issueComment = vi.fn(() => Promise.reject({ code: "comment_too_large" }));
  const view = mount({ ...api, issueComment } as Api, 1);
  view.commit();
  await flush();
  view.nodes().find((n) => n.type === Textarea)!.props.onChange({ target: { value: "x" } });
  findBtn(view, en("issues.comment.post")).props.onClick();
  await flush();
  expect(view.html()).toContain(en("error.comment_too_large"));
  expect(view.nodes().find((n) => n.type === Textarea)!.props.value).toBe("x");
});

// ---- timeline ----
it("loads the timeline only when it is opened", async () => {
  const api = createMockApi({});
  const issueTimeline = vi.fn(api.issueTimeline);
  const view = mount({ ...api, issueTimeline } as Api, 1);
  view.commit();
  await flush();
  expect(issueTimeline).not.toHaveBeenCalled();
  expect(view.html()).not.toContain(en("issues.timeline.closed", { actor: "x", subject: "" }));
  view.nodes().find((n) => n.type === "button" && n.props.children === en("issues.timeline"))!.props.onClick();
  await flush();
  expect(issueTimeline).toHaveBeenCalledWith("r1", 1);
  const html = view.html();
  expect(html).toContain(en("issues.timeline.labeled", { actor: "hubot", subject: "bug" }));
  expect(html).toContain(en("issues.timeline.renamed", { actor: "octocat", subject: "Footer meter overflows" }));
});

it("a timeline error stays in its section", async () => {
  const api = createMockApi({});
  const issueTimeline = vi.fn(() => Promise.reject({ code: "gh_failed", detail: "boom" }));
  const view = mount({ ...api, issueTimeline } as Api, 1);
  view.commit();
  await flush();
  view.nodes().find((n) => n.type === "button" && n.props.children === en("issues.timeline"))!.props.onClick();
  await flush();
  const html = view.html();
  expect(html).toContain("boom");
  expect(html).toContain(en("issues.comments", { count: 1 }));
  expect(html.match(/role="alert"/g)).toHaveLength(1);
});

it("says so when the timeline is empty", async () => {
  const api = createMockApi({});
  const view = mount({ ...api, issueTimeline: async () => [] } as Api, 1);
  view.commit();
  await flush();
  view.nodes().find((n) => n.type === "button" && n.props.children === en("issues.timeline"))!.props.onClick();
  await flush();
  expect(view.html()).toContain(en("issues.timeline.empty"));
});
