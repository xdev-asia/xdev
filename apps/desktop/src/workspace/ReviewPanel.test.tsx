import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api, type ReviewHost } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { MrPanel } from "./MrPanel";
import { PrPanel } from "./PrPanel";
import { ReviewPanel } from "./ReviewPanel";
import { PrStore } from "./prs";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: any) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[i], (v: unknown) => { hooks.values[i] = typeof v === "function" ? (v as any)(hooks.values[i]) : v; }];
    },
    useEffect: (effect: any) => void hooks.effects.push(effect),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const OAK = "/demo/wt/xdev-oak";

function api(host: ReviewHost): Api {
  const base = createMockApi({}, { workspace: { ...DEMO_WORKSPACE } });
  return { ...base, worktreeShip: async (path) => ({ ...(await base.worktreeShip(path)), reviewHost: host }) };
}

// One mount: the effects run once; every draw reads the same hook values.
function mount(a: Api, worktree = OAK) {
  const props = { api: a, worktree, prs: new PrStore(a), visible: true, page: true };
  const draw = () => { hooks.cursor = 0; return ReviewPanel(props) as Node; };
  hooks.effects = [];
  draw();
  const run = () => { const effects = hooks.effects; hooks.effects = []; effects.forEach((e) => e()); };
  run();
  return { draw, run, props, again: (next: string) => { props.worktree = next; draw(); run(); } };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => vi.restoreAllMocks());

it("says it is loading before the host is known", () => {
  const view = mount(api("gitlab"));
  const text = JSON.stringify(view.draw().props.children);
  expect(text).toContain(translate("en", "prPanel.loading"));
});

it("a GitLab worktree shows the merge request panel with the same worktree, visibility and page", async () => {
  const view = mount(api("gitlab"));
  await tick();
  const node = view.draw();
  expect(node.type).toBe(MrPanel);
  expect(node.props).toMatchObject({ worktree: OAK, visible: true, page: true });
});

it("a GitHub worktree shows the pull request panel", async () => {
  const view = mount(api("github"));
  await tick();
  expect(view.draw().type).toBe(PrPanel);
});

it("a failed read falls back to the pull request panel", async () => {
  const a = { ...api("gitlab"), worktreeShip: async () => { throw { code: "worktree_unknown" }; } } as Api;
  const view = mount(a);
  await tick();
  expect(view.draw().type).toBe(PrPanel);
});

it("another worktree reads the host again and shows loading meanwhile", async () => {
  const a = api("gitlab");
  const ship = vi.spyOn(a, "worktreeShip");
  const view = mount(a);
  await tick();
  expect(ship).toHaveBeenCalledTimes(1);
  view.again("/demo/wt/other");
  expect(ship).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(view.draw().props.children)).toContain(translate("en", "prPanel.loading"));
});
