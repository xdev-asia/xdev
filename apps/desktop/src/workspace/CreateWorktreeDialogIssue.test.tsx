import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Issue, type PrSummary } from "@/api";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { CreateWorktreeDialog, ISSUE_RESOLVE_DEBOUNCE_MS } from "./CreateWorktreeDialog";
import { LinkedWorkSearch } from "./LinkedWorkSearch";
import { isIssueRef } from "@/issues/issueStart";

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
    useRef: () => ({ current: null }),
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
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

afterEach(() => vi.useRealTimers());

const ISSUE: Issue = { number: 7, title: "Footer meter overflows", url: "https://github.com/o/r/issues/7", state: "open", labels: [], assignees: [], author: null, updatedAt: "2026-11-03T00:00:00Z" };

function mount(over: { resolve?: (repo: string, text: string) => Promise<Issue | null>; github?: boolean } = {}) {
  const repos = DEMO_WORKSPACE.repos;
  const onCreate = vi.fn();
  const onStartIssue = vi.fn();
  const onStartPr = vi.fn();
  const resolveIssue = vi.fn(over.resolve ?? (async () => ISSUE));
  const values: unknown[] = [];
  const cleanups: (void | (() => void))[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try {
      return CreateWorktreeDialog({ repos, repoId: repos[0].id, onCreate, onStartIssue, onStartPr, resolveIssue, ...(over.github ? { api: createMockApi({}) } : {}), onCancel: vi.fn() });
    } finally { hooks.active = false; }
  };
  const commit = () => {
    cleanups.splice(0).forEach((c) => typeof c === "function" && c());
    const before = hooks.effects.length;
    const tree = draw();
    cleanups.push(...hooks.effects.slice(before).map((effect) => effect()));
    return tree;
  };
  hooks.effects = [];
  let tree = commit();
  const type = (text: string) => {
    nodes(tree).find((n) => n.type === "input" && n.props.autoFocus)!.props.onChange({ target: { value: text } });
    tree = commit();
  };
  const submit = () => nodes(tree).find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  const create = () => nodes(tree).find((n) => n.props.type === "submit")!;
  const github = () => { nodes(tree).find((n) => n.props.label === en("workspace.create.tab.label"))!.props.onChange("github"); tree = commit(); return nodes(tree).find((n) => n.type === LinkedWorkSearch)!; };
  return { github, onStartPr, type, submit, create, text: () => JSON.stringify(nodes(tree).map((n) => n.props.children)), onCreate, onStartIssue, resolveIssue, repoId: repos[0].id, redraw: () => (tree = commit()) };
}

it("knows an issue number and an issue URL, and nothing else", () => {
  expect(isIssueRef("#123")).toBe(true);
  expect(isIssueRef(" #123 ")).toBe(true);
  expect(isIssueRef("https://github.com/o/r/issues/12")).toBe(true);
  expect(isIssueRef("https://github.com/o/r/issues/12/")).toBe(true);
  for (const no of ["123", "#", "#12a", "feat/login", "https://github.com/o/r/pull/12", ""]) expect(isIssueRef(no)).toBe(false);
});

it("resolves #7 after the pause, shows the title and starts from the issue on Create", async () => {
  vi.useFakeTimers();
  const m = mount();
  m.type("#7");
  expect(m.resolveIssue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(ISSUE_RESOLVE_DEBOUNCE_MS);
  await flush();
  expect(m.resolveIssue).toHaveBeenCalledWith(m.repoId, "#7");
  m.redraw();
  expect(m.text()).toContain("Footer meter overflows");
  m.submit();
  expect(m.onStartIssue).toHaveBeenCalledWith(m.repoId, ISSUE);
  expect(m.onCreate).not.toHaveBeenCalled();
});

it("keeps Create off while the issue is not resolved, and shows the error of a refused one", async () => {
  vi.useFakeTimers();
  const m = mount({ resolve: async () => Promise.reject({ code: "issue_other_repo" }) });
  m.type("#7");
  expect(m.create().props.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(ISSUE_RESOLVE_DEBOUNCE_MS);
  await flush();
  m.redraw();
  expect(m.text()).toContain(en("error.issue_other_repo"));
  expect(m.create().props.disabled).toBe(true);
  m.submit();
  expect(m.onStartIssue).not.toHaveBeenCalled();
});

it("an ordinary name never asks and goes through onCreate", async () => {
  vi.useFakeTimers();
  const m = mount();
  m.type("birch");
  await vi.advanceTimersByTimeAsync(ISSUE_RESOLVE_DEBOUNCE_MS * 2);
  expect(m.resolveIssue).not.toHaveBeenCalled();
  m.submit();
  expect(m.onCreate).toHaveBeenCalledTimes(1);
});

const PR = { number: 12, title: "Fix the footer", url: "https://github.com/o/r/pull/12", state: "open", head: "fix-footer", base: "main", author: null, fork: false, updatedAt: "2026-11-03T00:00:00Z" } as unknown as PrSummary;

it("an issue picked on the GitHub tab starts from the issue", () => {
  const m = mount({ github: true });
  const search = m.github();
  search.props.onPick({ kind: "issue", url: ISSUE.url, title: ISSUE.title }, { kind: "issue", issue: ISSUE });
  expect(m.onStartIssue).toHaveBeenCalledWith(m.repoId, ISSUE);
  expect(m.onStartPr).not.toHaveBeenCalled();
  expect(m.onCreate).not.toHaveBeenCalled();
});

it("a pull request picked on the GitHub tab starts from the pull request", () => {
  const m = mount({ github: true });
  const search = m.github();
  search.props.onPick({ kind: "pr", url: PR.url, title: PR.title }, { kind: "pr", pr: PR });
  expect(m.onStartPr).toHaveBeenCalledWith(m.repoId, PR);
  expect(m.onStartIssue).not.toHaveBeenCalled();
  expect(m.create().props.disabled).toBe(true);
});
