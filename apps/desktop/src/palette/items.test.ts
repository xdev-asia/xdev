import { chordLabel } from "@/keys/keymap";
import { expect, it, vi } from "vitest";
import type { RepoView, SessionRow, WorktreeView } from "@/api";
import { translate } from "@/i18n";
import { SETTING_ENTRIES } from "@/settings/catalog";
import { SECTIONS } from "@/settings/sections";
import type { Tab } from "@/workspace/sessions";
import { actionItems, sessionItems, settingItems, tabItems, validWorktreeName, worktreeItems } from "./items";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function wt(path: string, name: string, branch: string | null): WorktreeView {
  return { path, name, branch, head: null, start: null, primary: false, pinned: false, detached: branch === null, ...NO_DETAILS };
}

function repo(id: string, shortName: string, worktrees: WorktreeView[], missing = false): RepoView {
  return { id, shortName, path: `/r/${id}`, baseRef: "origin/main", worktreeRoot: "/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", color: null, icon: null, ghAccount: null, localIssueCommand: "", missing, worktrees, found: [] };
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
  expect(items.filter((i) => !i.minQuery).map((i) => i.id)).toEqual(SECTIONS.map((s) => `set:${s.id}`));
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

it("tab and terminal actions are listed in order with their own titles", () => {
  const f = vi.fn();
  const items = actionItems(t, { copyTerminalContext: f, pinTab: f, clearTerminal: f, unpinTab: f, moveTabRight: f, resetTerminal: f });
  expect(items.map((i) => i.id)).toEqual(["act:pinTab", "act:unpinTab", "act:moveTabRight", "act:clearTerminal", "act:resetTerminal", "act:copyTerminalContext"]);
  expect(items.every((i) => i.title !== "" && !i.title.startsWith("palette.") && i.keywords!.length > 0)).toBe(true);
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

function srow(key: string, worktree: string | null, last: number, title: string | null = key, resumable = true): SessionRow {
  return { session: { key, id: key, agent: "claude", branch: "main", title, last } as unknown as SessionRow["session"], worktree, repo: null, resumable };
}

it("sessionItems lists the newest 5 resumable sessions of the worktree as Resume: items that call resume", () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => srow(`s${i}`, "/a", 100 + i)),
    srow("other", "/b", 999),
    srow("gone", "/a", 998, "gone", false),
    srow("none", "/a", 500, null),
  ];
  const onResume = vi.fn();
  const items = sessionItems(rows, "/a", t, onResume);
  expect(items).toHaveLength(5);
  expect(items[0]?.title).toBe("Resume: Untitled session");
  expect(items.map((i) => i.id)).toEqual(["sess:none", "sess:s6", "sess:s5", "sess:s4", "sess:s3"]);
  items[1]?.run();
  expect(onResume).toHaveBeenCalledWith(rows[6]);
  expect(sessionItems(rows, null, t, onResume)).toEqual([]);
});

it("the Resume agent session action is listed only when the shell supplies it", () => {
  expect(actionItems(t, {}).some((i) => i.id === "act:resumeSession")).toBe(false);
  const open = vi.fn();
  const item = actionItems(t, { resumeSession: open }).find((i) => i.id === "act:resumeSession");
  item?.run();
  expect(open).toHaveBeenCalled();
});

import type { QuickCommand } from "@/api";
import { quickCommandItems } from "./items";
import { selectCommands } from "@/quickCommands/store";
import { NO_DETAILS } from "@/workspace/worktreeDetails";

const qcs: QuickCommand[] = [
  { id: "g", label: "Git status", scope: { type: "global" }, action: { type: "terminal", command: "git status", appendEnter: true } },
  { id: "a", label: "Tests", scope: { type: "repo", repo: "/r/x" }, action: { type: "terminal", command: "cargo test", appendEnter: true } },
  { id: "b", label: "Other repo", scope: { type: "repo", repo: "/r/y" }, action: { type: "terminal", command: "ls", appendEnter: true } },
];

it("quick command items: only the current repo's and global ones, then New", () => {
  const sel = selectCommands({ items: qcs, recent: [], files: {} }, "/r/x");
  const run = vi.fn();
  const create = vi.fn();
  const items = quickCommandItems([...sel.global, ...sel.project], "xdev", t, { run, create });
  expect(items.map((i) => i.title)).toEqual(["Run: Git status", "Run: Tests", "New quick command…"]);
  expect(items.map((i) => i.detail)).toEqual(["Global", "xdev", undefined]);
  items[1].run();
  expect(run).toHaveBeenCalledWith(qcs[1]);
  items[2].run();
  expect(create).toHaveBeenCalled();
});

it("setting entries follow the section items, with the section as detail", () => {
  const items = settingItems(t, vi.fn());
  const sections = SECTIONS.length;
  expect(items.slice(0, sections).map((i) => i.id)).toEqual(SECTIONS.map((s) => `set:${s.id}`));
  expect(items.length).toBe(sections + SETTING_ENTRIES.length);
  const entry = SETTING_ENTRIES[0];
  const item = items[sections];
  expect(item).toMatchObject({ id: `set:${entry.id}`, kind: "setting", title: t(entry.titleKey), minQuery: 2 });
  expect(item.detail).toBe(t(SECTIONS.find((s) => s.id === entry.section)!.labelKey));
  expect(item.keywords).toEqual(expect.arrayContaining([...entry.keywords]));
});

it("running a setting entry opens its section with the entry as target", () => {
  const onPick = vi.fn();
  const items = settingItems(t, onPick);
  const item = items.find((i) => i.id === "set:git.prefix")!;
  item.run();
  expect(onPick).toHaveBeenCalledWith("git", "git.prefix");
});
