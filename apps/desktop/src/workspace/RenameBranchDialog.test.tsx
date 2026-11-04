import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev-asia/ui";
import { createMockApi, type Api, type WorktreeView } from "@/api";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { NO_DETAILS } from "./worktreeDetails";
import { RenameBranchDialog, splitBranch } from "./RenameBranchDialog";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  return {
    ...react,
    useState: (initial: any) => {
      if (!hooks.active) return react.useState(initial);
      const { index, values } = slot(initial);
      return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
    },
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
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

const wt = (over: Partial<WorktreeView> = {}): WorktreeView => ({
  path: OAK, name: "oak", branch: "me/oak", head: null, start: "s", primary: false, pinned: false, detached: false, ...NO_DETAILS, ...over,
});

function mount(render: () => unknown) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(); } finally { hooks.active = false; }
  };
  draw();
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw() as ReactElement);
  return { all, html, find: (pick: (n: Node) => boolean) => all().find(pick) };
}

function dialog(api: Api, worktree = wt()) {
  const onRenamed = vi.fn();
  const onClose = vi.fn();
  const view = mount(() => RenameBranchDialog({ api, worktree, onRenamed, onClose }));
  const input = () => view.find((n) => n.type === "input" && n.props.name === "branchLeaf")!;
  const suggest = () => view.find((n) => n.type === "button" && n.props["data-suggest"] !== undefined)!;
  const save = () => view.find((n) => n.type === Button)!;
  const submit = () => view.find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  const error = () => view.find((n) => n.props.role === "alert")?.props.children;
  return { ...view, onRenamed, onClose, input, suggest, save, submit, error };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });
afterEach(() => vi.restoreAllMocks());

it("splits a branch into its fixed prefix and the leaf to edit", () => {
  expect(splitBranch("me/oak")).toEqual({ prefix: "me/", leaf: "oak" });
  expect(splitBranch("team/me/oak")).toEqual({ prefix: "team/me/", leaf: "oak" });
  expect(splitBranch("oak")).toEqual({ prefix: "", leaf: "oak" });
  expect(splitBranch(null)).toEqual({ prefix: "", leaf: "" });
});

it("shows the prefix as fixed text and the leaf in the field", () => {
  const view = dialog(createMockApi({}));
  expect(view.input().props.value).toBe("oak");
  expect(view.html()).toContain("me/");
  expect(view.html()).toContain(en("branchRename.title"));
});

it("renames with the typed leaf and reports the new view", async () => {
  const api = createMockApi({});
  const rename = vi.spyOn(api, "worktreeRenameBranch");
  const view = dialog(api, wt({ branch: "oak" }));
  view.input().props.onChange({ target: { value: "Fix the footer" } });
  view.submit();
  await tick();
  expect(rename).toHaveBeenCalledWith(OAK, "Fix the footer");
  expect(view.onRenamed).toHaveBeenCalledWith(expect.objectContaining({ branch: "fix-the-footer" }));
});

it("keeps Rename off for a blank or unchanged name", async () => {
  const api = createMockApi({});
  const rename = vi.spyOn(api, "worktreeRenameBranch");
  const view = dialog(api, wt({ branch: "oak" }));
  expect(view.save().props.disabled).toBe(true);
  view.input().props.onChange({ target: { value: "   " } });
  expect(view.save().props.disabled).toBe(true);
  view.submit();
  await tick();
  expect(rename).not.toHaveBeenCalled();
  view.input().props.onChange({ target: { value: "other" } });
  expect(view.save().props.disabled).toBe(false);
});

it("Suggest asks for a name for the worktree's latest session, fills the field and is busy meanwhile", async () => {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), prompts: { [OAK]: "fix the footer usage meter rounding" } } });
  const suggest = vi.spyOn(api, "worktreeSuggestBranch");
  const view = dialog(api, wt({ branch: "oak" }));
  view.suggest().props.onClick();
  expect(suggest).toHaveBeenCalledWith(OAK, null);
  expect(view.html()).toContain(en("branchRename.suggesting"));
  expect(view.suggest().props.disabled).toBe(true);
  await tick();
  expect(view.input().props.value).toBe("fix-the-footer-usage");
  expect(view.suggest().props.disabled).toBe(false);
});

it("Suggest with no usable prompt says so and leaves the field", async () => {
  const view = dialog(createMockApi({}), wt({ branch: "oak" }));
  view.suggest().props.onClick();
  await tick();
  expect(view.input().props.value).toBe("oak");
  expect(view.error()).toBe(en("branchRename.error.bad_name"));
});

it("shows a refused rename by its code", async () => {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), remotes: { [OAK]: { ahead: 0, behind: 0 } } } });
  const view = dialog(api, wt({ branch: "oak" }));
  view.input().props.onChange({ target: { value: "x" } });
  view.submit();
  await tick();
  expect(view.error()).toBe(en("error.branch_pushed"));
  expect(view.onRenamed).not.toHaveBeenCalled();

  const bad = dialog(createMockApi({}), wt({ branch: "oak" }));
  bad.input().props.onChange({ target: { value: "..." } });
  bad.submit();
  await tick();
  expect(bad.error()).toBe(en("branchRename.error.bad_name"));
});
