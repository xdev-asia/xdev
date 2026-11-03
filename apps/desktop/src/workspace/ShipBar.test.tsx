import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev/ui";
import { createMockApi, type Api, type PrView } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { translate } from "@/i18n";
import { CreatePrDialog } from "./CreatePrDialog";
import { PrStore } from "./prs";
import { ShipBar } from "./ShipBar";

// Hooks are stubbed only while a component under test is called; each harness keeps its own.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  const state = (initial: unknown) => {
    const { index, values } = slot(initial);
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
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

// Calls `render` with its own hook values; the first draw's effects run once, as on mount.
function mount(render: () => unknown) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  const cleanups = hooks.effects.slice(before).map((effect) => effect());
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw() as ReactElement);
  const find = (pick: (n: Node) => boolean) => all().find(pick);
  return { draw, all, html, find, cleanups };
}


function bar(api: Api, extra: { checked?: number } = {}) {
  const prs = new PrStore(api);
  const onCommit = vi.fn();
  const onChanged = vi.fn();
  const view = mount(() => ShipBar({ api, worktree: OAK, checked: extra.checked ?? 0, prs, onCommit, onChanged }));
  const main = () => view.find((n) => n.type === Button)!;
  const more = () => view.find((n) => n.props["aria-haspopup"] === "menu")!;
  const item = (label: string) => view.find((n) => n.props.role === "menuitem" && n.props.children === label)!;
  const openMenu = () => more().props.onClick();
  return { ...view, prs, onCommit, onChanged, main, more, item, openMenu };
}

function seeded(remotes: Record<string, { ahead: number; behind: number }> = {}): Api {
  return createMockApi({}, { workspace: { ...DEMO_WORKSPACE, remotes } });
}

const PR: PrView = { number: 7, url: "https://example.test/pull/7", state: "open", title: "t", base: "main", head: "oak" };

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows branch to base with counts and commits", async () => {
  const api = seeded();
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  const view = bar(api);
  await tick();
  const html = view.html();
  expect(html).toContain(en("ship.branchRow", { branch: "oak", base: "main" }));
  expect(html).toContain(en("ship.counts", { added: 3, removed: 0 }));
  expect(html).toContain(en("ship.commits", { count: 1 }));
  expect(html).toContain(en("ship.upstream.none"));
  // The subjects wait until the person asks.
  expect(html).not.toContain("feat: one");
  view.find((n) => n.props.className === "ws-ship-commits")!.props.onClick();
  const open = view.html();
  expect(open).toContain("feat: one");
  expect(open).toContain("aaaaaaa");
});

it("names the upstream when the range counts against it", async () => {
  const api = createMockApi({}, { workspace: { ...DEMO_WORKSPACE, git: { compareAgainstUpstream: true } } });
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  const before = bar(api);
  await tick();
  expect(before.html()).not.toContain(en("ship.rangeVs", { ref: "origin/oak" }));
  await api.worktreePush(OAK);
  hooks.values = []; hooks.effects = [];
  const after = bar(api);
  await tick();
  expect(after.html()).toContain(en("ship.rangeVs", { ref: "origin/oak" }));
  expect(after.html()).toContain(en("ship.counts", { added: 0, removed: 0 }));
});

it("main button follows state: commit, publish, push, create PR, open PR", async () => {
  // Checked changes first.
  const first = bar(seeded(), { checked: 2 });
  await tick();
  expect(first.main().props.children).toBe(en("ship.action.commit"));
  first.main().props.onClick();
  expect(first.onCommit).toHaveBeenCalledTimes(1);

  // A commit that is not on the remote yet: publish.
  const api = seeded();
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  const push = vi.spyOn(api, "worktreePush");
  const view = bar(api);
  await tick();
  expect(view.main().props.children).toBe(en("ship.action.publish"));
  view.main().props.onClick();
  await tick();
  expect(push).toHaveBeenCalledWith(OAK);
  expect(view.onChanged).toHaveBeenCalled();
  // Published and level: a pull request is next.
  expect(view.main().props.children).toBe(en("ship.action.create_pr"));

  // A later commit goes up with a plain push.
  await api.worktreeCommit(OAK, ["src/status.ts"], "feat: two");
  view.cleanups.forEach((c) => typeof c === "function" && c());
  const again = bar(api);
  await tick();
  expect(again.main().props.children).toBe(en("ship.action.push"));
  again.main().props.onClick();
  await tick();

  // Create PR opens the dialog with the base filled and an empty title.
  expect(again.main().props.children).toBe(en("ship.action.create_pr"));
  again.main().props.onClick();
  const dialog = again.find((n) => n.type === CreatePrDialog)!;
  expect(dialog.props.initial).toEqual({ base: "main", title: "", body: "", draft: false });
  const created = await api.worktreePrCreate(OAK, { base: "main", title: "T", body: "", draft: false });
  dialog.props.onCreated(created);
  expect(again.prs.get(OAK)?.pr?.number).toBe(created.number);
  expect(again.find((n) => n.type === CreatePrDialog)).toBeUndefined();

  // With a pull request the button opens it.
  expect(again.main().props.children).toBe(en("ship.action.open_pr"));
  const open = vi.spyOn(api, "worktreePrOpen");
  again.main().props.onClick();
  await tick();
  expect(open).toHaveBeenCalledWith(OAK, false);
});

it("pull and sync from the menu", async () => {
  const api = seeded({ [OAK]: { ahead: 0, behind: 2 } });
  const pull = vi.spyOn(api, "worktreePull");
  const sync = vi.spyOn(api, "worktreeSync");
  const fetch = vi.spyOn(api, "worktreeFetch");
  const view = bar(api);
  await tick();
  expect(view.html()).toContain(en("ship.upstream.state", { ahead: 0, behind: 2 }));
  view.openMenu();
  view.item(en("ship.more.pull")).props.onClick();
  await tick();
  expect(pull).toHaveBeenCalledWith(OAK);
  expect(view.html()).toContain(en("ship.upstream.state", { ahead: 0, behind: 0 }));
  view.openMenu();
  view.item(en("ship.more.sync")).props.onClick();
  await tick();
  expect(sync).toHaveBeenCalledWith(OAK);
  view.openMenu();
  view.item(en("ship.more.fetch")).props.onClick();
  await tick();
  expect(fetch).toHaveBeenCalledWith(OAK);
});

it("force push asks and sends the shown lease", async () => {
  const api = seeded({ [OAK]: { ahead: 1, behind: 1 } });
  const force = vi.spyOn(api, "worktreeForcePush");
  const view = bar(api);
  await tick();
  view.openMenu();
  const entry = view.item(en("ship.more.force"));
  expect(entry.props.disabled).toBe(false);
  entry.props.onClick();
  const dialog = view.find((n) => n.type === ConfirmDialog)!;
  expect(dialog.props.open).toBe(true);
  expect(dialog.props.body).toBe(en("ship.force.body", { remote: "origin", branch: "oak", id: "bbbbbbb" }));
  expect(force).not.toHaveBeenCalled();
  dialog.props.onConfirm();
  await tick();
  expect(force).toHaveBeenCalledWith(OAK, "b".repeat(40), true);
  expect(view.find((n) => n.type === ConfirmDialog)!.props.open).toBe(false);
});

it("force push cancel sends nothing", async () => {
  const api = seeded({ [OAK]: { ahead: 1, behind: 1 } });
  const force = vi.spyOn(api, "worktreeForcePush");
  const view = bar(api);
  await tick();
  view.openMenu();
  view.item(en("ship.more.force")).props.onClick();
  view.find((n) => n.type === ConfirmDialog)!.props.onCancel();
  await tick();
  expect(force).not.toHaveBeenCalled();
  expect(view.find((n) => n.type === ConfirmDialog)!.props.open).toBe(false);
});

it("force push stays disabled without an upstream", async () => {
  const view = bar(seeded());
  await tick();
  view.openMenu();
  expect(view.item(en("ship.more.force")).props.disabled).toBe(true);
});

it("diverged disables the main button and shows the note", async () => {
  const view = bar(seeded({ [OAK]: { ahead: 2, behind: 1 } }));
  await tick();
  expect(view.main().props.disabled).toBe(true);
  expect(view.html()).toContain(en("ship.diverged.note"));
  // The note offers the same confirmed force push.
  view.find((n) => n.props.className === "ws-ship-link")!.props.onClick();
  expect(view.find((n) => n.type === ConfirmDialog)!.props.open).toBe(true);
});

it("push_rejected shows inline", async () => {
  const api = seeded();
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  vi.spyOn(api, "worktreePush").mockRejectedValue({ code: "push_rejected" });
  const view = bar(api);
  await tick();
  view.main().props.onClick();
  await tick();
  expect(view.html()).toContain(en("error.push_rejected"));
});

it("shows the pull request number from the store", async () => {
  const api = seeded();
  const view = bar(api);
  await tick();
  view.prs.set(OAK, PR);
  expect(view.html()).toContain(en("ship.pr.label", { number: 7 }));
});
