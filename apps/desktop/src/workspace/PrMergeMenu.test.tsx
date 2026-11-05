import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api, type MergeBlock, type PrMergeInfo, type PrView } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PrMergeMenu } from "./PrMergeMenu";
import { PrStore } from "./prs";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  return {
    ...react,
    useState: (initial: any) => {
      const i = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[i], (v: unknown) => { hooks.values[i] = typeof v === "function" ? (v as any)(hooks.values[i]) : v; }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: (effect: any) => void hooks.effects.push(effect),
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
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const PR: PrView = { number: 7, url: "u", state: "open", title: "t", base: "main", head: "oak" };
const INFO: PrMergeInfo = { block: null, checksFailed: false, methods: ["squash", "merge", "rebase"], defaultMethod: "squash" };

function api(info: PrMergeInfo, extra: Partial<Api> = {}): Api {
  return { ...createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [OAK]: PR }, mergeInfo: { [OAK]: info } } }), ...extra };
}

// One mount: effects run once, then every draw reads the same hook values.
async function mount(a: Api, prs: PrStore, pr: PrView = PR) {
  hooks.values = []; hooks.cursor = 0; hooks.effects = [];
  const draw = () => { hooks.cursor = 0; return PrMergeMenu({ api: a, worktree: OAK, pr, prs }) as ReactElement | null; };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  return { tree: () => nodes(draw()), dialog: () => nodes(draw()).find((n) => n.type === ConfirmDialog)! };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

const text = (n: Node) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children ?? ""));

it("shows the default method on the one primary button", async () => {
  const a = api({ ...INFO, defaultMethod: "rebase" });
  const m = await mount(a, new PrStore(a));
  const buttons = m.tree().filter((n) => typeof n.type !== "string" && (n.type as any).name === "Button");
  expect(buttons).toHaveLength(1);
  expect(text(buttons[0])).toBe(en("prReview.merge.rebase"));
  expect(buttons[0].props.disabled).toBe(false);
});

it("hides for a merged or closed PR", async () => {
  const a = api(INFO);
  const m = await mount(a, new PrStore(a), { ...PR, state: "merged" });
  expect(m.tree()).toEqual([]);
});

it.each<MergeBlock>(["merged", "closed", "draft", "review-required", "changes-requested", "conflicts", "merge-queue", "unknown", "behind", "blocked"])(
  "disables the button and says why when %s",
  async (block) => {
    const a = api({ ...INFO, block });
    const m = await mount(a, new PrStore(a));
    const all = m.tree();
    const button = all.find((n) => typeof n.type !== "string" && (n.type as any).name === "Button")!;
    expect(button.props.disabled).toBe(true);
    expect(all.some((n) => n.props.children === en(`prReview.block.${block}`))).toBe(true);
  },
);

it("warns in the confirmation when a check failed", async () => {
  const a = api({ ...INFO, checksFailed: true });
  const m = await mount(a, new PrStore(a));
  expect(m.dialog().props.warning).toBe(en("prReview.merge.warn.checks"));
  expect(m.dialog().props.title).toBe(en("prReview.merge.confirm.squash", { number: 7 }));
  expect(m.dialog().props.body).toBe(en("prReview.merge.body.squash", { head: "oak", base: "main" }));
});

it("merges with the chosen method, then reloads the PR", async () => {
  const merge = vi.fn(async () => {});
  const a = api(INFO, { worktreePrMerge: merge });
  const prs = new PrStore(a);
  const load = vi.spyOn(prs, "load");
  const m = await mount(a, prs);
  const menu = m.tree().find((n) => n.props.label === en("prReview.merge.menu") && Array.isArray(n.props.items));
  expect(menu).toBeUndefined(); // closed until the chevron is pressed
  m.tree().find((n) => n.props.icon === "chevron")!.props.onClick();
  const items = m.tree().find((n) => Array.isArray(n.props.items))!.props.items;
  expect(items.map((i: any) => i.label)).toEqual([en("prReview.merge.squash"), en("prReview.merge.merge"), en("prReview.merge.rebase")]);
  expect(items[0].checked).toBe(true);
  items[1].onSelect();
  expect(m.dialog().props.title).toBe(en("prReview.merge.confirm.merge", { number: 7 }));
  m.dialog().props.onConfirm();
  m.dialog().props.onConfirm(); // a second press while the first runs
  await tick();
  expect(merge).toHaveBeenCalledTimes(1);
  expect(merge).toHaveBeenCalledWith(OAK, 7, "merge");
  expect(load).toHaveBeenCalledWith(OAK, { checks: true });
  expect(m.tree().some((n) => n.props.children === en("prReview.merge.done"))).toBe(true);
});

it("shows the block named by a refusal and the host detail of a failure", async () => {
  const refuse = api(INFO, { worktreePrMerge: async () => Promise.reject({ code: "merge_blocked", detail: "behind" }) });
  const m = await mount(refuse, new PrStore(refuse));
  m.dialog().props.onConfirm();
  await tick();
  expect(m.tree().some((n) => n.props.children === en("prReview.block.behind"))).toBe(true);

  const failing = api(INFO, { worktreePrMerge: async () => Promise.reject({ code: "gh_failed", detail: "boom" }) });
  const f = await mount(failing, new PrStore(failing));
  f.dialog().props.onConfirm();
  await tick();
  expect(f.tree().some((n) => String(n.props.children).includes("boom"))).toBe(true);
});
