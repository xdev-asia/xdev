import { expect, it } from "vitest";
import type { RepoView, SidebarItem, SidebarPrefs, WorkItem, WorktreeView } from "@/api";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { NO_DETAILS } from "./worktreeDetails";
import { groupWorktrees } from "./groups";
import { activeProjects, filterByProject, flattenRepos, itemLabel, moveTarget, nestRows, pinnedEntries, projectListRepeatsCards, repeatedRepos, sectionHeadless, topIds, visibleEntries, type WtEntry } from "./sidebarModel";

const OFF: SidebarPrefs = SIDEBAR_PREFS_DEFAULTS;

function wt(name: string, extra: Partial<WorktreeView> = {}): WorktreeView {
  return { path: `/wt/${name}`, name, branch: name, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS, ...extra };
}
function repo(id: string, worktrees: WorktreeView[]): RepoView {
  return { id, shortName: id, path: `/code/${id}`, baseRef: "main", worktreeRoot: "/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", docsDir: "docs", color: null, icon: null, ghAccount: null, localIssueCommand: "", missing: false, worktrees, found: [] };
}
const entries = (r: RepoView): WtEntry[] => r.worktrees.map((w) => ({ path: w.path, wt: w, repo: r }));
const asRepo = (r: RepoView): SidebarItem => ({ kind: "repo", repo: r, kept: [] });

it("nests children under their parent with a count", () => {
  const r = repo("a", [wt("p"), wt("c1", { parent: "/wt/p" }), wt("c2", { parent: "/wt/p" }), wt("solo")]);
  const rows = nestRows(entries(r), new Set());
  expect(rows.map((x) => [x.entry.wt.name, x.depth, x.children])).toEqual([["p", 1, 2], ["c1", 2, 0], ["c2", 2, 0], ["solo", 1, 0]]);
  // Collapsed: the children go, the count stays.
  const folded = nestRows(entries(r), new Set(["/wt/p"]));
  expect(folded.map((x) => [x.entry.wt.name, x.children])).toEqual([["p", 2], ["solo", 0]]);
});

it("a child of a missing parent, or of a parent in another section, is top-level", () => {
  const r = repo("a", [wt("c", { parent: "/wt/gone" })]);
  expect(nestRows(entries(r), new Set()).map((x) => x.depth)).toEqual([1]);
  // Only the child is in this list (the parent sits in another status section).
  const s = repo("a", [wt("p"), wt("c", { parent: "/wt/p" })]);
  expect(nestRows(entries(s).slice(1), new Set()).map((x) => x.depth)).toEqual([1]);
});

it("filters hide rows but never the selected one", () => {
  const r = repo("a", [wt("main", { primary: true, defaultBranch: true }), wt("det", { detached: true, branch: null }), wt("bot", { madeBy: "automation" }), wt("cli", { madeBy: "cli" }), wt("x")]);
  expect(visibleEntries(entries(r), OFF, null).hidden).toBe(0);
  const def = visibleEntries(entries(r), { ...OFF, hideDefault: true }, null);
  expect(def.entries.map((e) => e.wt.name)).toEqual(["det", "bot", "cli", "x"]);
  expect(def.hidden).toBe(1);
  // The selected row stays even when a filter would hide it.
  expect(visibleEntries(entries(r), { ...OFF, hideDefault: true }, "/wt/main").hidden).toBe(0);
  const all = visibleEntries(entries(r), { ...OFF, hideDefault: true, hideDetached: true, hideAutomation: true, hideCli: true }, "/wt/det");
  expect(all.entries.map((e) => e.wt.name)).toEqual(["det", "x"]);
  expect(all.hidden).toBe(3);
});

it("work item label is the number, the title or the host", () => {
  const item = (url: string, title: string | null = null): WorkItem => ({ kind: "pr", url, title });
  expect(itemLabel(item("https://x.test/o/r/pull/42"))).toBe("#42");
  expect(itemLabel(item("https://x.test/o/r/pull/42/"))).toBe("#42");
  expect(itemLabel(item("https://x.test/board", "Board"))).toBe("Board");
  expect(itemLabel(item("https://x.test/board"))).toBe("x.test");
  expect(itemLabel(item("not a url"))).toBe("not a url");
});

it("flattens groups to repos in shown order", () => {
  const a = repo("a", []);
  const b = repo("b", []);
  const c = repo("c", []);
  const items: SidebarItem[] = [asRepo(a), { kind: "group", group: { id: "g", name: "G", members: ["b", "c"] }, items: [asRepo(b), asRepo(c)] }];
  expect(flattenRepos(items).map((r) => r.id)).toEqual(["a", "b", "c"]);
  expect(topIds(items)).toEqual(["a", "g"]);
});

it("alt+arrow moves a top-level item, or a member inside its group", () => {
  const a = repo("a", []);
  const b = repo("b", []);
  const c = repo("c", []);
  const items: SidebarItem[] = [asRepo(a), asRepo(b), { kind: "group", group: { id: "g", name: "G", members: ["c"] }, items: [asRepo(c)] }];
  expect(moveTarget(items, "b", -1)).toEqual({ order: ["b", "a", "g"] });
  expect(moveTarget(items, "a", -1)).toBeNull();
  expect(moveTarget(items, "g", -1)).toEqual({ order: ["a", "g", "b"] });
  expect(moveTarget(items, "c", 1)).toBeNull();
  const two: SidebarItem[] = [{ kind: "group", group: { id: "g", name: "G", members: ["b", "c"] }, items: [asRepo(b), asRepo(c)] }];
  expect(moveTarget(two, "c", -1)).toEqual({ member: "c", group: "g", index: 0 });
});

import { dropMove } from "./sidebarModel";

it("dropping a repo on a group heading moves it in; on a row it goes before that row", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => repo(id, []));
  const items: SidebarItem[] = [asRepo(a), asRepo(b), { kind: "group", group: { id: "g", name: "G", members: ["c", "d"] }, items: [asRepo(c), asRepo(d)] }];
  expect(dropMove(items, "a", "g")).toEqual({ member: "a", group: "g", index: 0 });
  expect(dropMove(items, "b", "a")).toEqual({ order: ["b", "a", "g"] });
  expect(dropMove(items, "a", "b")).toEqual({ order: ["a", "b", "g"] });
  expect(dropMove(items, "g", "a")).toEqual({ order: ["g", "a", "b"] });
  expect(dropMove(items, "g", "c")).toBeNull();
  expect(dropMove(items, "c", "a")).toEqual({ member: "c", group: null, index: 0 });
  expect(dropMove(items, "a", "d")).toEqual({ member: "a", group: "g", index: 1 });
  expect(dropMove(items, "a", "a")).toBeNull();
});

it("pinnedEntries lists pinned worktrees in sidebar order, repo by repo, groups opened up", () => {
  const a = repo("a", [wt("a1"), wt("a2", { pinned: true }), wt("a3", { pinned: true })]);
  const b = repo("b", [wt("b1", { pinned: true })]);
  const c = repo("c", [wt("c1")]);
  const items: SidebarItem[] = [
    { kind: "group", group: { id: "g", name: "G", members: ["b"] }, items: [asRepo(b)] },
    asRepo(a),
    asRepo(c),
  ];
  expect(pinnedEntries(items).map((e) => [e.repo.id, e.wt.name])).toEqual([["b", "b1"], ["a", "a2"], ["a", "a3"]]);
  // Each entry is keyed by its path and carries its repo.
  expect(pinnedEntries(items)[1]).toMatchObject({ path: "/wt/a2", repo: { id: "a" } });
  // Nothing pinned, nothing listed; a missing repo adds nothing.
  expect(pinnedEntries([asRepo(c), asRepo({ ...repo("m", []), missing: true })])).toEqual([]);
  expect(pinnedEntries([])).toEqual([]);
});

it("Sleeping only keeps the worktrees that are asleep and counts the rest as hidden", () => {
  const r = repo("a", [wt("a1"), wt("a2"), wt("a3")]);
  const asleep = { "/wt/a2": true, "/wt/a3": false };
  const on = visibleEntries(entries(r), OFF, null, { only: true, asleep });
  expect(on.entries.map((e) => e.wt.name)).toEqual(["a2"]);
  expect(on.hidden).toBe(2);
  const off = visibleEntries(entries(r), OFF, null, { only: false, asleep });
  expect(off.entries).toHaveLength(3);
  expect(off.hidden).toBe(0);
  expect(visibleEntries(entries(r), OFF, null).hidden).toBe(0);
});

it("Sleeping only never hides the selected worktree and combines with the other filters", () => {
  const r = repo("a", [wt("main", { defaultBranch: true }), wt("a2"), wt("a3")]);
  const asleep = { "/wt/main": true, "/wt/a2": true };
  expect(visibleEntries(entries(r), OFF, "/wt/a3", { only: true, asleep }).entries.map((e) => e.wt.name)).toEqual(["main", "a2", "a3"]);
  const both = visibleEntries(entries(r), { ...OFF, hideDefault: true }, null, { only: true, asleep });
  expect(both.entries.map((e) => e.wt.name)).toEqual(["a2"]);
  expect(both.hidden).toBe(2);
});

it("the project filter keeps the listed projects; empty or unknown ids keep all", () => {
  const a = repo("a", [wt("a1")]);
  const b = repo("b", [wt("b1"), wt("b2")]);
  const all = [...entries(a), ...entries(b)];
  const names = (list: WtEntry[]) => list.map((e) => e.wt.name);
  expect(names(filterByProject(all, []))).toEqual(["a1", "b1", "b2"]);
  expect(names(filterByProject(all, ["b"]))).toEqual(["b1", "b2"]);
  expect(names(filterByProject(all, ["a", "b"]))).toEqual(["a1", "b1", "b2"]);
  // An id that is no listed repo is ignored; a filter of only such ids keeps every project.
  expect(names(filterByProject(all, ["a", "gone"]))).toEqual(["a1"]);
  expect(names(filterByProject(all, ["gone"]))).toEqual(["a1", "b1", "b2"]);
  expect(activeProjects(["x"], ["a"])).toBeNull();
  expect(activeProjects(["a", "x"], ["a"])).toEqual(new Set(["a"]));
});

it("the project filter combines with the other filters and counts what it hides", () => {
  const a = repo("a", [wt("a1"), wt("a2", { detached: true })]);
  const b = repo("b", [wt("b1")]);
  const all = [...entries(a), ...entries(b)];
  const prefs = { ...OFF, projectFilter: ["a"], hideDetached: true };
  const out = visibleEntries(all, prefs, null);
  expect(out.entries.map((e) => e.wt.name)).toEqual(["a1"]);
  expect(out.hidden).toBe(2);
  // The selected worktree stays even outside the filter.
  expect(visibleEntries(all, prefs, "/wt/b1").entries.map((e) => e.wt.name)).toEqual(["a1", "b1"]);
  // With the sleeping filter on too.
  const sleeping = { only: true, asleep: { "/wt/a1": false, "/wt/b1": true } };
  expect(visibleEntries(all, { ...OFF, projectFilter: ["a"] }, null, sleeping).entries).toEqual([]);
});

it("a worktree hidden from the sidebar is dropped without counting as filtered, unless selected", () => {
  const a = repo("a", [wt("main", { primary: true }), wt("x"), wt("y")]);
  const prefs = { ...OFF, hiddenWorktrees: ["/wt/x", "/wt/main"] };
  const out = visibleEntries(entries(a), prefs, null);
  expect(out.entries.map((e) => e.wt.name)).toEqual(["main", "y"]);
  expect(out.hidden).toBe(0);
  expect(visibleEntries(entries(a), prefs, "/wt/x").entries.map((e) => e.wt.name)).toEqual(["main", "x", "y"]);
});

it("the project list repeats the card of a lone project with nothing archived", () => {
  const r = repo("demo", [wt("main", { primary: true })]);
  const drawn = new Set(r.worktrees.map((w) => w.path));
  expect(projectListRepeatsCards([asRepo(r)], drawn)).toBe(true);
  // Not when the card is not drawn, something is archived, the folder is gone or there is more than one project.
  expect(projectListRepeatsCards([asRepo(r)], new Set())).toBe(false);
  expect(projectListRepeatsCards([{ kind: "repo", repo: r, kept: [{ branch: "old" } as never] }], drawn)).toBe(false);
  expect(projectListRepeatsCards([asRepo({ ...r, missing: true })], drawn)).toBe(false);
  expect(projectListRepeatsCards([asRepo(r), asRepo(repo("other", [wt("o")]))], drawn)).toBe(false);
});

it("repos in a group whose cards are drawn have no project row; the group and top-level repos keep theirs", () => {
  const a = repo("a", [wt("a1")]);
  const b = repo("b", [wt("b1")]);
  const c = repo("c", [wt("c1")]);
  const group = { kind: "group", group: { id: "g", name: "G", members: ["a", "b"] }, items: [asRepo(a), asRepo(b)] } as never;
  const drawn = new Set(["a", "b", "c"].map((id) => `/wt/${id}1`));
  expect([...repeatedRepos([group, asRepo(c)], drawn)].sort()).toEqual(["a", "b"]);
  // A group is more than its cards, so the list stays.
  expect(projectListRepeatsCards([group, asRepo(c)], drawn)).toBe(false);
  // Hidden cards or something archived keep the row.
  expect([...repeatedRepos([group], new Set(["/wt/a1"]))]).toEqual(["a"]);
  const keeps = { kind: "group", group: { id: "k", name: "K", members: ["c"] }, items: [{ kind: "repo", repo: c, kept: [{ branch: "old" } as never] }] } as never;
  expect([...repeatedRepos([keeps], drawn)]).toEqual([]);
});

it("a lone Other section has no heading; named sections and pinned rows keep theirs", () => {
  expect(sectionHeadless({ mode: "activity", id: "rest" }, 1, 0)).toBe(true);
  // The id the activity grouping really gives an idle worktree.
  const [idle] = groupWorktrees([{ path: "/a" }], () => null);
  expect(sectionHeadless({ mode: "activity", id: idle!.group }, 1, 0)).toBe(true);
  expect(sectionHeadless({ mode: "activity", id: "rest" }, 2, 0)).toBe(false);
  expect(sectionHeadless({ mode: "activity", id: "rest" }, 1, 1)).toBe(false);
  expect(sectionHeadless({ mode: "activity", id: "working" }, 1, 0)).toBe(false);
  expect(sectionHeadless({ mode: "status", id: "none" }, 1, 0)).toBe(false);
});
