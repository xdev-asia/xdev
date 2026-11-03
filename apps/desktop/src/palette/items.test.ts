import { chordLabel } from "@/keys/keymap";
import { expect, it, vi } from "vitest";
import type { RepoView, WorktreeView } from "@/api";
import { translate } from "@/i18n";
import { SECTIONS } from "@/settings/sections";
import type { Tab } from "@/workspace/sessions";
import { actionItems, settingItems, tabItems, validWorktreeName, worktreeItems } from "./items";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function wt(path: string, name: string, branch: string | null): WorktreeView {
  return { path, name, branch, head: null, start: null, primary: false, pinned: false, detached: branch === null };
}

function repo(id: string, shortName: string, worktrees: WorktreeView[], missing = false): RepoView {
  return { id, shortName, path: `/r/${id}`, baseRef: "origin/main", worktreeRoot: "/wt", missing, worktrees, found: [] };
}

function tab(id: string, worktree: string, profileId: string, agent: boolean, status: Tab["status"] = "idle"): Tab {
  return { id, worktree, profileId, account: null, permissions: "ask", agent, status } as Tab;
}

const repos = [
  repo("x", "xdev", [wt("/wt/oak", "oak", "feat/oak"), wt("/wt/elm", "elm", null)]),
  repo("y", "gone", [wt("/wt/fir", "fir", "main")], true),
];

it("worktree items carry repo, branch and detached label", () => {
  const onPick = vi.fn();
  const items = worktreeItems(repos, { dot: (p) => (p === "/wt/oak" ? "working" : null), activity: (p) => (p === "/wt/oak" ? 5 : null), detached: "detached", onPick });
  expect(items.map((i) => i.id)).toEqual(["wt:/wt/oak", "wt:/wt/elm"]);
  expect(items[0]).toMatchObject({ kind: "worktree", title: "oak", detail: "xdev · feat/oak", status: "working", activity: 5, worktree: "/wt/oak" });
  expect(items[0].keywords).toEqual(expect.arrayContaining(["/wt/oak", "xdev/feat/oak"]));
  expect(items[1].detail).toBe("xdev · detached");
  items[1].run();
  expect(onPick).toHaveBeenCalledWith(repos[0].worktrees[1]);
});

it("missing repos list no worktrees", () => {
  const items = worktreeItems(repos, { dot: () => null, activity: () => null, detached: "detached", onPick: vi.fn() });
  expect(items.some((i) => i.id === "wt:/wt/fir")).toBe(false);
});

it("tab items use attention over tab status", () => {
  const tabs: Record<string, Tab[]> = { "/wt/oak": [tab("p1", "/wt/oak", "claude", true, "idle"), tab("p2", "/wt/oak", "shell", false, "working")] };
  const onPick = vi.fn();
  const items = tabItems(repos, (p) => tabs[p] ?? [], { name: (x) => x.profileId, attention: (id) => (id === "p1" ? "needs-you" : null), onPick });
  expect(items.map((i) => i.id)).toEqual(["tab:p1", "tab:p2"]);
  expect(items[0]).toMatchObject({ kind: "tab", title: "claude", detail: "xdev / oak", status: "needs-you", worktree: "/wt/oak" });
  expect(items[1].status).toBe("working");
  items[1].run();
  expect(onPick).toHaveBeenCalledWith(tabs["/wt/oak"][1]);
});

it("agent and terminal keywords", () => {
  const tabs = [tab("p1", "/wt/oak", "claude", true), tab("p2", "/wt/oak", "shell", false)];
  const items = tabItems(repos, (p) => (p === "/wt/oak" ? tabs : []), { name: (x) => x.profileId, onPick: vi.fn() });
  expect(items[0].keywords).toContain("agent");
  expect(items[1].keywords).toContain("terminal");
});

it("setting items follow SECTIONS", () => {
  const onPick = vi.fn();
  const items = settingItems(t, onPick);
  expect(items.map((i) => i.id)).toEqual(SECTIONS.map((s) => `set:${s.id}`));
  expect(items[0]).toMatchObject({ kind: "setting", title: t(SECTIONS[0].labelKey), detail: t("settings.title") });
  items[1].run();
  expect(onPick).toHaveBeenCalledWith(SECTIONS[1].id);
});

it("actions without a handler are left out", () => {
  const newWorktree = vi.fn();
  const items = actionItems(t, { newWorktree, searchDocs: vi.fn() });
  expect(items.map((i) => i.id)).toEqual(["act:newWorktree", "act:searchDocs"]);
  expect(items[0]).toMatchObject({ kind: "action", title: t("palette.action.newWorktree") });
  expect(items[0].keywords).toContain("create");
  expect(items[1].hint).toMatch(/K$/);
  items[0].run();
  expect(newWorktree).toHaveBeenCalled();
});

it("stage and discard all are listed only when the worktree can run them", () => {
  const stageAll = vi.fn();
  const discardAll = vi.fn();
  const items = actionItems(t, { stageAll, discardAll });
  expect(items.map((i) => i.id)).toEqual(["act:stageAll", "act:discardAll"]);
  expect(items[0].title).toBe(t("palette.action.stageAll"));
  expect(items[1].title).toBe(t("palette.action.discardAll"));
  items[0].run();
  items[1].run();
  expect(stageAll).toHaveBeenCalled();
  expect(discardAll).toHaveBeenCalled();
  expect(actionItems(t, { newWorktree: vi.fn() }).map((i) => i.id)).toEqual(["act:newWorktree"]);
});

it("validWorktreeName", () => {
  expect(validWorktreeName("fix-login")).toBe(true);
  expect(validWorktreeName("feat/x")).toBe(true);
  expect(validWorktreeName("  ")).toBe(false);
  expect(validWorktreeName("two words")).toBe(false);
  expect(validWorktreeName("a..b")).toBe(false);
  expect(validWorktreeName("-x")).toBe(false);
});

it("the new tab actions show the keymap's chords", () => {
  const items = actionItems(t, { newAgentTab: vi.fn(), newShellTab: vi.fn() });
  expect(items.map((i) => i.hint)).toEqual([chordLabel("agent.new"), chordLabel("tab.new")]);
  expect(items[1].hint).toMatch(/T$/);
});

it("Terminal shows among the setting items", () => {
  const onPick = vi.fn();
  const items = settingItems(t, onPick);
  const terminal = items.find((i) => i.id === "set:terminal")!;
  expect(terminal).toMatchObject({ kind: "setting", title: t("settings.terminal.title") });
  terminal.run();
  expect(onPick).toHaveBeenCalledWith("terminal");
});
