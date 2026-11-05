import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type Check, type PrView } from "@/api";
import { DEFAULT_GIT_SETTINGS, DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { ChecksPanel } from "./ChecksPanel";
import { PrStore } from "./prs";
import { PrCommentStore } from "./prCommentStore";

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
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
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
const PR: PrView = { number: 7, url: "https://example.test/pull/7", state: "open", title: "Fix the thing", base: "main", head: "oak" };
const CHECKS: Check[] = [
  { name: "build", workflow: "ci", bucket: "pass", link: null },
  { name: "test", workflow: "ci", bucket: "pending", link: null },
  { name: "lint", workflow: "ci", bucket: "fail", link: "https://example.test/actions/runs/5/job/9" },
];

function seeded(prs: Record<string, PrView> = {}, checks: Record<string, Check[]> = {}): Api {
  return createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs, checks } });
}

// Draws with its own hook values; the first draw's effects run once, as on mount.
function mount(api: Api, prs: PrStore, visible: boolean, onFix?: (check: Check) => void | Promise<void>, comments?: PrCommentStore) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return ChecksPanel({ api, worktree: OAK, prs, visible, onFix, comments }); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  const cleanups = hooks.effects.slice(before).map((effect) => effect());
  return { all: () => nodes(draw()), html: () => renderToStaticMarkup(draw()), cleanups };
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("lists checks with state dots", async () => {
  const api = seeded({ [OAK]: PR }, { [OAK]: CHECKS });
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  const html = mount(api, prs, true).html();
  expect(html).toContain("#7");
  expect(html).toContain("Fix the thing");
  expect(html).toContain(en("checks.state.open"));
  for (const bucket of ["pass", "pending", "fail"]) expect(html).toContain(`data-check="${bucket}"`);
  for (const name of ["build", "test", "lint"]) expect(html).toContain(`>${name}<`);
});

it("no PR shows the empty line", async () => {
  const api = seeded();
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  const html = mount(api, prs, true).html();
  expect(html).toContain(en("checks.noPr"));
  expect(html).not.toContain(en("checks.openPr"));
});

it("checks tab shows gh_auth reason", async () => {
  const api = seeded({ [OAK]: PR });
  vi.spyOn(api, "worktreePr").mockRejectedValue({ code: "gh_auth" });
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  const html = mount(api, prs, true).html();
  expect(html).toContain(en("checks.reason.gh_auth"));
  expect(html).not.toContain(en("checks.noPr"));
});

it("open on GitHub calls worktreePrOpen", async () => {
  const api = seeded({ [OAK]: PR }, { [OAK]: CHECKS });
  const open = vi.spyOn(api, "worktreePrOpen");
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  const view = mount(api, prs, true);
  const button = (label: string) => view.all().find((n) => n.type === "button" && n.props.children === label)!;
  button(en("checks.openPr")).props.onClick();
  button(en("checks.openChecks")).props.onClick();
  expect(open.mock.calls).toEqual([[OAK, false], [OAK, true]]);
});

it("refreshes every 30 s only while pending and visible", async () => {
  vi.useFakeTimers();
  const api = seeded({ [OAK]: PR }, { [OAK]: CHECKS });
  const read = vi.spyOn(api, "worktreePr");
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  read.mockClear();

  const shown = mount(api, prs, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(3);
  for (const clean of shown.cleanups) if (typeof clean === "function") clean();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(3);

  // Hidden: the mount load only.
  read.mockClear();
  mount(api, prs, false);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(read).toHaveBeenCalledTimes(1);

  // Nothing pending: the mount load only.
  const done = seeded({ [OAK]: PR }, { [OAK]: CHECKS.map((c) => ({ ...c, bucket: "pass" as const })) });
  const quiet = new PrStore(done);
  await quiet.load(OAK, { checks: true });
  const calm = vi.spyOn(done, "worktreePr");
  mount(done, quiet, true);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(calm).toHaveBeenCalledTimes(1);
});

const fixButtons = (view: ReturnType<typeof mount>) => view.all().filter((n) => n.type === "button" && n.props["data-fix"] !== undefined);

it("offers Fix with agent on failed checks only, and hands the check over", async () => {
  const api = seeded({ [OAK]: PR }, { [OAK]: CHECKS });
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  let done!: () => void;
  const onFix = vi.fn(() => new Promise<void>((resolve) => { done = resolve; }));
  const view = mount(api, prs, true, onFix);
  await tick();
  const buttons = fixButtons(view);
  expect(buttons.map((b) => b.props["data-fix"])).toEqual(["lint"]);
  expect(buttons[0]!.props.children).toBe(en("checks.fix"));
  buttons[0]!.props.onClick();
  expect(onFix).toHaveBeenCalledWith(CHECKS[2]);
  // One at a time: the button waits while the prompt is prepared.
  expect(fixButtons(view)[0]!.props.disabled).toBe(true);
  done();
  await tick();
  expect(fixButtons(view)[0]!.props.disabled).toBe(false);
});

it("hides Fix with agent without a handler or with the agent actions off", async () => {
  const api = seeded({ [OAK]: PR }, { [OAK]: CHECKS });
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  const bare = mount(api, prs, true);
  await tick();
  expect(fixButtons(bare)).toHaveLength(0);

  const off = createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [OAK]: PR }, checks: { [OAK]: CHECKS }, git: { ...DEFAULT_GIT_SETTINGS, sourceControlAi: false } } });
  const offPrs = new PrStore(off);
  await offPrs.load(OAK, { checks: true });
  const hidden = mount(off, offPrs, true, vi.fn());
  await tick();
  expect(fixButtons(hidden)).toHaveLength(0);
});

it("mounts the PR comments under the checks", async () => {
  const api = createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [OAK]: PR }, checks: { [OAK]: CHECKS }, prComments: { [OAK]: [] } } });
  const prs = new PrStore(api);
  await prs.load(OAK, { checks: true });
  const comments = new PrCommentStore(api);
  const view = mount(api, prs, true, undefined, comments);
  await tick();
  const html = view.html();
  expect(html).toContain(en("prc.title", { count: 0 }));
  expect(html.indexOf(`>lint<`)).toBeLessThan(html.indexOf(en("prc.title", { count: 0 })));
  expect(mount(api, prs, true).html()).not.toContain(en("prc.title", { count: 0 }));
});
