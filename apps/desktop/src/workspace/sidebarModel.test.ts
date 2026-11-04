import { expect, it } from "vitest";
import type { RepoView, SidebarItem, SidebarPrefs, WorkItem, WorktreeView } from "@/api";
import { NO_DETAILS } from "./worktreeDetails";
import { flattenRepos, itemLabel, moveTarget, nestRows, topIds, visibleEntries, type WtEntry } from "./sidebarModel";

const OFF: SidebarPrefs = { hideDefault: false, hideDetached: false, hideAutomation: false, hideCli: false };

function wt(name: string, extra: Partial<WorktreeView> = {}): WorktreeView {
  return { path: `/wt/${name}`, name, branch: name, head: null, start: null, primary: false, pinned: false, detached: false, ...NO_DETAILS, ...extra };
}
function repo(id: string, worktrees: WorktreeView[]): RepoView {
  return { id, shortName: id, path: `/code/${id}`, baseRef: "main", worktreeRoot: "/wt", setupPolicy: "ask", scriptSource: "auto", localSetup: "", localArchive: "", docsDir: "docs", missing: false, worktrees, found: [] };
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
  const all = visibleEntries(entries(r), { hideDefault: true, hideDetached: true, hideAutomation: true, hideCli: true }, "/wt/det");
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
