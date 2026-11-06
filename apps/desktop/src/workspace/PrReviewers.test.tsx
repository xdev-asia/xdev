import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchPicker, Tag } from "@xdev-asia/ui";
import { createMockApi, type Api, type ApiError, type PrDetail, type PrReviewer } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { PrReviewers, reviewerItems, validReviewer } from "./PrReviewers";

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
const REVIEWERS: PrReviewer[] = [{ login: "grace", state: "approved" }, { login: "linus", state: "requested" }];
const DETAIL: PrDetail = {
  number: 7, url: "https://example.test/pull/7", state: "open", title: "Fix", body: "", author: "ada", base: "main", head: "oak",
  reviewDecision: null, mergeable: "mergeable", mergeState: "clean", reviewers: REVIEWERS, entries: [], files: [], autoMerge: null,
};

function seeded(candidates?: string[]): Api {
  return createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prDetails: { [OAK]: structuredClone(DETAIL) }, reviewerCandidates: candidates } });
}

function mount(api: Api, extra: { editable?: boolean; reviewers?: PrReviewer[] } = {}) {
  const values: unknown[] = [];
  const changed = vi.fn();
  const errors: ApiError[] = [];
  const props = { api, worktree: OAK, number: 7, reviewers: extra.reviewers ?? REVIEWERS, editable: extra.editable ?? true, onChanged: changed, onError: (e: ApiError) => errors.push(e) };
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return PrReviewers(props); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  for (const effect of hooks.effects.slice(before)) effect();
  return { all: () => nodes(draw()), html: () => renderToStaticMarkup(draw()), changed, errors };
}
const picker = (view: ReturnType<typeof mount>) => view.all().find((n) => n.type === SearchPicker)!;

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => { vi.restoreAllMocks(); });

it("a reviewer is a login or org/team, nothing that could pass as a flag or a list", () => {
  for (const good of ["ada", "a-b", "acme/core", "acme/web_team"]) expect(validReviewer(good)).toBe(true);
  for (const bad of ["", "-x", "--web", "a,b", "a b", "acme/", "acme/-x", "x".repeat(40)]) expect(validReviewer(bad)).toBe(false);
});

it("the picker offers matching collaborators not asked yet, then the typed name", () => {
  const all = ["ada", "adam", "grace", "bob"];
  expect(reviewerItems("", all, [])).toEqual([]);
  expect(reviewerItems("ad", all, ["Adam"]).map((i) => i.id)).toEqual(["ada", "ad"]);
  expect(reviewerItems("ada", all, []).map((i) => i.id)).toEqual(["ada", "adam"]);
  expect(reviewerItems("grace", all, ["grace"])).toEqual([]);
  expect(reviewerItems("acme/core", [], []).map((i) => i.id)).toEqual(["acme/core"]);
  expect(reviewerItems("a b", [], [])).toEqual([]);
});

it("shows each reviewer as a chip with a status dot and its verdict, removable while open", async () => {
  const view = mount(seeded(["ada"]));
  await tick();
  const html = view.html();
  expect(html).toContain("grace");
  expect(html).toContain(en("prPanel.verdict.approved"));
  expect(html).toContain('data-tone="ok"');
  expect(html).toContain('data-tone="warn"');
  expect(html).toContain(en("prPanel.reviewers.remove", { login: "linus" }));
  expect(html).not.toContain("border-left");
});

it("picking a name asks it for a review; remove on a chip drops the request", async () => {
  const api = seeded(["ada", "bob"]);
  const edit = vi.spyOn(api, "worktreePrReviewers");
  const view = mount(api);
  await tick();
  picker(view).props.onValueChange("ad");
  expect(picker(view).props.items.map((i: { id: string }) => i.id)).toEqual(["ada", "ad"]);
  picker(view).props.onPick("ada");
  await tick();
  expect(edit).toHaveBeenCalledWith(OAK, 7, ["ada"], []);
  expect(view.changed).toHaveBeenCalledTimes(1);
  expect(picker(view).props.value).toBe("");
  view.all().find((n) => n.type === Tag && n.props.removeLabel === en("prPanel.reviewers.remove", { login: "linus" }))!.props.onRemove();
  await tick();
  expect(edit).toHaveBeenLastCalledWith(OAK, 7, [], ["linus"]);
});

it("a closed collaborator list still takes a typed login", async () => {
  const api = seeded();
  const view = mount(api);
  await tick();
  picker(view).props.onValueChange("zed");
  expect(picker(view).props.items.map((i: { id: string }) => i.id)).toEqual(["zed"]);
  expect(picker(view).props.status).toBe(en("prPanel.reviewers.noCandidates"));
  picker(view).props.onValueChange("not a name");
  expect(picker(view).props.status).toBe(en("error.bad_reviewer"));
});

it("a failed request reports the error and keeps the name", async () => {
  const api = seeded(["ada"]);
  vi.spyOn(api, "worktreePrReviewers").mockRejectedValue({ code: "gh_scope", detail: "read:org" });
  const view = mount(api);
  await tick();
  picker(view).props.onValueChange("ada");
  picker(view).props.onPick("ada");
  await tick();
  expect(view.errors.map((e) => e.code)).toEqual(["gh_scope"]);
  expect(view.changed).not.toHaveBeenCalled();
  expect(picker(view).props.value).toBe("ada");
});

it("a merged pull request lists reviewers without the picker, removes or a candidate read", async () => {
  const api = seeded(["ada"]);
  const read = vi.spyOn(api, "worktreePrReviewerCandidates");
  const view = mount(api, { editable: false });
  await tick();
  expect(read).not.toHaveBeenCalled();
  expect(view.all().some((n) => n.type === SearchPicker)).toBe(false);
  expect(view.html()).not.toContain(en("prPanel.reviewers.remove", { login: "grace" }));
  expect(mount(api, { editable: false, reviewers: [] }).html()).toContain(en("prPanel.noReviewers"));
});
