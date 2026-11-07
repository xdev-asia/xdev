import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api, type MergeBlock, type PrMergeInfo, type PrView } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PrMergeMenu, type MergeSource } from "./PrMergeMenu";
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
const INFO: PrMergeInfo = { block: null, checksFailed: false, methods: ["squash", "merge", "rebase"], defaultMethod: "squash", headOid: "abc123" };

function api(info: PrMergeInfo, extra: Partial<Api> = {}): Api {
  return { ...createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [OAK]: PR }, mergeInfo: { [OAK]: info } } }), ...extra };
}

// One mount: effects run once, then every draw reads the same hook values.
async function mount(a: Api, prs: PrStore | undefined, pr: PrView = PR, source?: MergeSource) {
  hooks.values = []; hooks.cursor = 0; hooks.effects = [];
  const draw = () => { hooks.cursor = 0; return PrMergeMenu({ api: a, worktree: OAK, pr, prs, source }) as ReactElement | null; };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  return { rerun: () => { draw(); hooks.effects.forEach((e) => e()); }, tree: () => nodes(draw()), dialog: () => nodes(draw()).find((n) => n.type === ConfirmDialog)! };
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

it("shows the error with a retry when the merge state cannot be read, then recovers", async () => {
  let fail = true;
  const read = vi.fn(async () => (fail ? Promise.reject({ code: "gh_failed", detail: "offline" }) : INFO));
  const a = api(INFO, { worktreePrMergeInfo: read });
  const m = await mount(a, new PrStore(a));
  const alert = m.tree().find((n) => n.props.role === "alert");
  expect(alert && text(alert)).toContain(en("error.gh_failed"));
  const retry = m.tree().find((n) => n.props.onClick && text(n) === en("prReview.merge.retry"))!;
  expect(retry).toBeDefined();
  expect(m.tree().some((n) => typeof n.type !== "string" && (n.type as any).name === "Button" && text(n) === en("prReview.merge.squash"))).toBe(false);
  fail = false;
  hooks.effects = [];
  retry.props.onClick();
  m.rerun();
  await tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(m.tree().some((n) => text(n) === en("prReview.merge.squash"))).toBe(true);
  expect(m.tree().some((n) => n.props.role === "alert")).toBe(false);
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
  expect(merge).toHaveBeenCalledWith(OAK, 7, "merge", "abc123");
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

const MR: PrView = { number: 12, url: "u", state: "open", title: "t", base: "main", head: "oak" };
function source(info: PrMergeInfo, over: Partial<MergeSource> = {}): MergeSource & { merge: ReturnType<typeof vi.fn>; after: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(async () => info), merge: vi.fn(async () => {}), after: vi.fn(async () => {}), words: "mrReview", errorText: (e: unknown) => `E:${(e as { code: string }).code}`, ...over } as never;
}

it("with a source: merges through it, never touches the GitHub calls, then reloads", async () => {
  const gh = vi.fn();
  const a = api(INFO, { worktreePrMergeInfo: gh, worktreePrMerge: gh });
  const src = source({ ...INFO, checksFailed: true });
  const m = await mount(a, undefined, MR, src);
  expect(m.dialog().props.title).toBe(en("mrReview.merge.confirm.squash", { number: 12 }));
  expect(m.dialog().props.warning).toBe(en("mrReview.merge.warn.checks"));
  m.dialog().props.onConfirm();
  await tick();
  expect(src.merge).toHaveBeenCalledTimes(1);
  expect(src.merge).toHaveBeenCalledWith("squash", "abc123");
  expect(src.after).toHaveBeenCalledTimes(1);
  expect(gh).not.toHaveBeenCalled();
  expect(m.tree().some((n) => text(n) === en("mrReview.merge.done"))).toBe(true);
});

it("with a source: a block reads from the source words, other errors from errorText", async () => {
  const a = api(INFO);
  const blocked = source(INFO, { merge: vi.fn(async () => Promise.reject({ code: "merge_blocked", detail: "conflicts" })) as never });
  const m = await mount(a, undefined, MR, blocked);
  m.dialog().props.onConfirm();
  await tick();
  expect(m.tree().some((n) => n.props.role === "alert" && text(n) === en("mrReview.block.conflicts"))).toBe(true);
  const moved = source(INFO, { merge: vi.fn(async () => Promise.reject({ code: "pr_head_moved" })) as never });
  const m2 = await mount(a, undefined, MR, moved);
  m2.dialog().props.onConfirm();
  await tick();
  expect(m2.tree().some((n) => n.props.role === "alert" && text(n) === "E:pr_head_moved")).toBe(true);
});

it("with a source: a draft block disables the one primary button", async () => {
  const a = api(INFO);
  const m = await mount(a, undefined, MR, source({ ...INFO, block: "draft" }));
  const all = m.tree();
  const buttons = all.filter((n) => typeof n.type !== "string" && (n.type as any).name === "Button");
  expect(buttons).toHaveLength(1);
  expect(buttons[0].props.disabled).toBe(true);
  expect(all.some((n) => n.props.children === en("mrReview.block.draft"))).toBe(true);
});
