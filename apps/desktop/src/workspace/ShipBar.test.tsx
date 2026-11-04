import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev-asia/ui";
import { createMockApi, type Api, type GitSettings, type PrView } from "@/api";
import { DEFAULT_GIT_SETTINGS, DEMO_WORKSPACE } from "@/mockWorkspace";
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


function bar(api: Api, extra: { checked?: number; git?: GitSettings; onFixPush?: (output: string, branch: string) => void; hasMessage?: boolean; onCommitFirst?: () => Promise<boolean> } = {}) {
  const prs = new PrStore(api);
  const onCommit = vi.fn();
  const onChanged = vi.fn();
  const view = mount(() => ShipBar({ api, worktree: OAK, checked: extra.checked ?? 0, prs, onCommit, onChanged, git: extra.git, onFixPush: extra.onFixPush, hasMessage: extra.hasMessage, onCommitFirst: extra.onCommitFirst }));
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
  view.item(en("ship.update.sync", { behind: 0, ahead: 0 })).props.onClick();
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

it("offers a fix for a failed push, with git's output and the branch", async () => {
  const api = seeded();
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  vi.spyOn(api, "worktreePush").mockRejectedValue({ code: "push_rejected", detail: "! [rejected] oak -> oak (fetch first)" });
  const onFixPush = vi.fn();
  const view = bar(api, { onFixPush });
  await tick();
  const fix = () => view.find((n) => n.props["data-fix"] === "push");
  expect(fix()).toBeUndefined();
  view.main().props.onClick();
  await tick();
  expect(fix()!.props.children).toBe(en("ship.push.fix"));
  fix()!.props.onClick();
  expect(onFixPush).toHaveBeenCalledWith(`${en("error.push_rejected")}\n! [rejected] oak -> oak (fetch first)`, "oak");
});

it("offers no fix when the agent actions are off, there is no handler, or the error is not a push's", async () => {
  const failing = async () => {
    const api = seeded();
    await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
    vi.spyOn(api, "worktreePush").mockRejectedValue({ code: "push_rejected" });
    return api;
  };
  const fixOf = (view: ReturnType<typeof bar>) => view.find((n) => n.props["data-fix"] === "push");
  const attempt = async (extra: Parameters<typeof bar>[1]) => {
    hooks.values = []; hooks.effects = [];
    const view = bar(await failing(), extra);
    await tick();
    view.main().props.onClick();
    await tick();
    return view;
  };
  expect(fixOf(await attempt({ onFixPush: vi.fn(), git: { ...DEFAULT_GIT_SETTINGS, sourceControlAi: false } }))).toBeUndefined();
  expect(fixOf(await attempt({}))).toBeUndefined();
  // A pull that fails is not a push.
  hooks.values = []; hooks.effects = [];
  const api = await failing();
  vi.spyOn(api, "worktreePull").mockRejectedValue({ code: "git", detail: "x" });
  const view = bar(api, { onFixPush: vi.fn() });
  await tick();
  view.openMenu();
  view.item(en("ship.more.pull")).props.onClick();
  await tick();
  expect(view.html()).toContain(en("error.git"));
  expect(fixOf(view)).toBeUndefined();
  // A policy stop is not for an agent.
  vi.spyOn(api, "worktreePush").mockRejectedValue({ code: "denied", detail: "no" });
  hooks.values = []; hooks.effects = [];
  const denied = bar(api, { onFixPush: vi.fn() });
  await tick();
  denied.main().props.onClick();
  await tick();
  expect(fixOf(denied)).toBeUndefined();
});

it("shows the pull request number from the store", async () => {
  const api = seeded();
  const view = bar(api);
  await tick();
  view.prs.set(OAK, PR);
  expect(view.html()).toContain(en("ship.pr.label", { number: 7 }));
});

it("hands the pull request defaults from Settings → Git to Create PR", async () => {
  const api = seeded();
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  await api.worktreePush(OAK);
  const open = async (git?: GitSettings) => {
    hooks.values = []; hooks.effects = [];
    const view = bar(api, { git });
    await tick();
    expect(view.main().props.children).toBe(en("ship.action.create_pr"));
    view.main().props.onClick();
    return view.find((n) => n.type === CreatePrDialog)!.props;
  };
  const on = await open({ ...DEFAULT_GIT_SETTINGS, prDraft: true, prGenerateOnOpen: true, prOpenAfterCreate: true });
  expect(on).toMatchObject({ initial: { base: "main", title: "", body: "", draft: true }, ai: true, generateOnOpen: true, openAfterCreate: true });
  // With the agent actions off nothing drafts on open, and the agent button goes.
  const off = await open({ ...DEFAULT_GIT_SETTINGS, sourceControlAi: false, prGenerateOnOpen: true });
  expect(off).toMatchObject({ ai: false, generateOnOpen: false, openAfterCreate: false });
  // Not given: the defaults.
  expect(await open()).toMatchObject({ initial: { draft: false }, ai: true, generateOnOpen: false, openAfterCreate: false });
});

const updating = (over: Record<string, unknown> = {}) => createMockApi({}, { workspace: { ...DEMO_WORKSPACE, remotes: { [OAK]: { ahead: 0, behind: 2 } }, ...over } });

it("Fast-forward calls the API and shows the new state", async () => {
  const api = updating();
  const ff = vi.spyOn(api, "worktreeFastForward");
  const view = bar(api);
  await tick();
  view.openMenu();
  view.item(en("ship.update.fastForward", { count: 2 })).props.onClick();
  await tick();
  expect(ff).toHaveBeenCalledWith(OAK);
  expect(view.html()).toContain(en("ship.upstream.state", { ahead: 0, behind: 0 }));
});

it("Rebase from the base calls the API; a conflict stop shows its line", async () => {
  const api = updating();
  const rebase = vi.spyOn(api, "worktreeRebaseFromBase").mockRejectedValue({ code: "update_conflicts" });
  const view = bar(api);
  await tick();
  view.openMenu();
  view.item(en("ship.update.rebase", { ref: "main" })).props.onClick();
  await tick();
  expect(rebase).toHaveBeenCalledWith(OAK);
  expect(view.html()).toContain(en("ship.update.conflicts.rebase"));
});

it("names the operation in each update error line", async () => {
  const cases: [string, "worktreeFastForward" | "worktreeRebaseFromBase", string, string][] = [
    ["update_dirty", "worktreeRebaseFromBase", "ship.update.dirty.rebase", "ship.update.rebase"],
    ["update_dirty", "worktreeFastForward", "ship.update.dirty.fastForward", "ship.update.fastForward"],
    ["update_untracked", "worktreeRebaseFromBase", "ship.update.untracked.rebase", "ship.update.rebase"],
    ["update_untracked", "worktreeFastForward", "ship.update.untracked.fastForward", "ship.update.fastForward"],
    ["update_conflicted", "worktreeRebaseFromBase", "ship.update.conflicted.rebase", "ship.update.rebase"],
  ];
  for (const [code, method, line, label] of cases) {
    hooks.values = []; hooks.effects = [];
    const api = updating();
    vi.spyOn(api, method).mockRejectedValue({ code });
    const view = bar(api);
    await tick();
    view.openMenu();
    view.item(en(label, { ref: "main", count: 2 })).props.onClick();
    await tick();
    expect(view.html(), `${code} ${method}`).toContain(en(line));
  }
  // A git failure carries git's words.
  hooks.values = []; hooks.effects = [];
  const api = updating();
  vi.spyOn(api, "worktreeRebaseFromBase").mockRejectedValue({ code: "git", detail: "boom" });
  const view = bar(api);
  await tick();
  view.openMenu();
  view.item(en("ship.update.rebase", { ref: "main" })).props.onClick();
  await tick();
  expect(view.html()).toContain(en("ship.update.failed.rebase", { detail: "boom" }));
});

it("Commit & push commits, then pushes, in that order", async () => {
  const api = seeded();
  const order: string[] = [];
  const push = vi.spyOn(api, "worktreePush").mockImplementation(async (p) => { order.push("push"); return api.worktreeShip(p); });
  const onCommitFirst = vi.fn(async () => { order.push("commit"); return true; });
  const view = bar(api, { checked: 1, hasMessage: true, onCommitFirst });
  await tick();
  view.openMenu();
  view.item(en("ship.combo.push")).props.onClick();
  await tick();
  expect(order).toEqual(["commit", "push"]);
  expect(push).toHaveBeenCalledWith(OAK);
});

it("a commit that fails or is not made sends nothing", async () => {
  const api = seeded();
  const push = vi.spyOn(api, "worktreePush");
  const sync = vi.spyOn(api, "worktreeSync");
  const view = bar(api, { checked: 1, hasMessage: true, onCommitFirst: async () => false });
  await tick();
  view.openMenu();
  view.item(en("ship.combo.push")).props.onClick();
  await tick();
  view.openMenu();
  view.item(en("ship.combo.sync")).props.onClick();
  await tick();
  expect(push).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
});

it("a push that fails after the commit keeps it and offers Fix with agent", async () => {
  const api = seeded();
  vi.spyOn(api, "worktreePush").mockRejectedValue({ code: "push_rejected", detail: "no" });
  const onCommitFirst = vi.fn(async () => true);
  const view = bar(api, { checked: 1, hasMessage: true, onCommitFirst, onFixPush: vi.fn() });
  await tick();
  view.openMenu();
  view.item(en("ship.combo.push")).props.onClick();
  await tick();
  expect(onCommitFirst).toHaveBeenCalledTimes(1);
  expect(view.html()).toContain(en("error.push_rejected"));
  expect(view.find((n) => n.props["data-fix"] === "push")).toBeDefined();
});

it("Commit & sync commits, then syncs", async () => {
  const api = updating();
  const sync = vi.spyOn(api, "worktreeSync");
  const view = bar(api, { checked: 1, hasMessage: true, onCommitFirst: async () => true });
  await tick();
  view.openMenu();
  view.item(en("ship.combo.sync")).props.onClick();
  await tick();
  expect(sync).toHaveBeenCalledWith(OAK);
});

it("Commit & force push commits, asks, then sends the lease", async () => {
  const api = updating({ remotes: { [OAK]: { ahead: 1, behind: 1 } }, rewritten: { [OAK]: true } });
  const force = vi.spyOn(api, "worktreeForcePush");
  const onCommitFirst = vi.fn(async () => true);
  const view = bar(api, { checked: 1, hasMessage: true, onCommitFirst });
  await tick();
  view.openMenu();
  // Commit & sync is off for a rewrite.
  expect(view.item(en("ship.combo.sync")).props.disabled).toBe(true);
  view.item(en("ship.combo.forcePush")).props.onClick();
  await tick();
  expect(onCommitFirst).toHaveBeenCalledTimes(1);
  const dialog = view.find((n) => n.type === ConfirmDialog)!;
  expect(dialog.props.open).toBe(true);
  expect(force).not.toHaveBeenCalled();
  dialog.props.onConfirm();
  await tick();
  expect(force).toHaveBeenCalledWith(OAK, "b".repeat(40), true);
});

it("needs_force from Sync opens the force confirm instead of an error", async () => {
  const api = updating({ remotes: { [OAK]: { ahead: 1, behind: 1 } }, rewritten: { [OAK]: true } });
  const view = bar(api);
  await tick();
  view.openMenu();
  view.item(en("ship.update.sync", { behind: 1, ahead: 1 })).props.onClick();
  await tick();
  expect(view.find((n) => n.type === ConfirmDialog)!.props.open).toBe(true);
  expect(view.html()).not.toContain(en("error.needs_force"));
});

it("Push before pull request pushes, then opens the dialog", async () => {
  const api = seeded();
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  const push = vi.spyOn(api, "worktreePush");
  const view = bar(api);
  await tick();
  view.openMenu();
  view.item(en("ship.combo.pushThenPr")).props.onClick();
  await tick();
  expect(push).toHaveBeenCalledWith(OAK);
  expect(view.find((n) => n.type === CreatePrDialog)).toBeDefined();
});

it("Push before pull request opens no dialog when the push fails", async () => {
  const api = seeded();
  await api.worktreeCommit(OAK, ["src/session.ts"], "feat: one");
  vi.spyOn(api, "worktreePush").mockRejectedValue({ code: "push_rejected" });
  const view = bar(api);
  await tick();
  view.openMenu();
  view.item(en("ship.combo.pushThenPr")).props.onClick();
  await tick();
  expect(view.find((n) => n.type === CreatePrDialog)).toBeUndefined();
  expect(view.html()).toContain(en("error.push_rejected"));
});
