import { expect, it } from "vitest";
import { STATUS_DEFAULTS } from "@/status/statusSettings";
import type { Tab } from "@/workspace/sessions";
import type { ActivityOptions } from "./options";
import { STATUS_ORDER, activityThreads, hasAgentThreads, type ThreadSource } from "./threads";

const names = { "/a": { name: "oak", branch: "feat/oak" }, "/b": { name: "elm", branch: null } };
const src = (id: string, over: Partial<Tab>, lastOutput: number | null): ThreadSource => ({
  tab: { id, worktree: "/a", profileId: "claude", agent: true, status: "working", title: null, ...over } as Tab,
  lastOutput,
});
const ids = (groups: ReturnType<typeof activityThreads>) => groups.flatMap((g) => g.threads.map((t) => t.tab.id));
const off: ActivityOptions = { showIdle: false, groupBy: "none", filter: "all", compact: false };

it("lists agent tabs only, newest output first", () => {
  const tabs = [src("old", {}, 1), src("shell", { agent: false }, 9), src("new", {}, 5), src("none", {}, null)];
  expect(ids(activityThreads(tabs, names, "", off))).toEqual(["new", "old", "none"]);
});

it("hides idle and ended threads unless showIdle", () => {
  const tabs = [src("w", {}, 3), src("i", { status: "idle" }, 2), src("e", { status: "exited" }, 1), src("n", { status: "needs-you" }, 0)];
  expect(ids(activityThreads(tabs, names, "", off))).toEqual(["w", "n"]);
  expect(ids(activityThreads(tabs, names, "", { ...off, showIdle: true }))).toEqual(["w", "i", "e", "n"]);
});

it("the query matches title, worktree, branch and profile, any case, every word", () => {
  const tabs = [src("t", { title: "Fix Parser" }, 3), src("b", { worktree: "/b", profileId: "codex" }, 2)];
  expect(ids(activityThreads(tabs, names, "parser", off))).toEqual(["t"]);
  expect(ids(activityThreads(tabs, names, "FEAT/OAK", off))).toEqual(["t"]);
  expect(ids(activityThreads(tabs, names, "elm", off))).toEqual(["b"]);
  expect(ids(activityThreads(tabs, names, "codex", off))).toEqual(["b"]);
  expect(ids(activityThreads(tabs, names, "oak parser", off))).toEqual(["t"]);
  expect(ids(activityThreads(tabs, names, "oak elm", off))).toEqual([]);
});

it("ungrouped is one group; grouped keeps the output order by worktree", () => {
  const tabs = [src("a1", {}, 5), src("b1", { worktree: "/b" }, 4), src("a2", {}, 3)];
  const flat = activityThreads(tabs, names, "", off);
  expect(flat).toHaveLength(1);
  expect(flat[0]).toMatchObject({ kind: "none", key: null, worktree: null, name: null });
  const grouped = activityThreads(tabs, names, "", { ...off, groupBy: "worktree" });
  expect(grouped.map((g) => [g.worktree, g.name, g.threads.map((t) => t.tab.id)])).toEqual([
    ["/a", "oak", ["a1", "a2"]],
    ["/b", "elm", ["b1"]],
  ]);
});

it("the unread filter keeps unread tabs the settings admit", () => {
  const tabs = [
    src("u", { unread: true, unreadReason: "needs-you" }, 3),
    src("d", { unread: true, unreadReason: "done" }, 2),
    src("r", { unread: false }, 1),
  ];
  const unread: ActivityOptions = { ...off, filter: "unread" };
  expect(ids(activityThreads(tabs, names, "", unread))).toEqual(["u", "d"]);
  const quiet = { ...STATUS_DEFAULTS, enabled: true, onNeedsInput: true, onDone: false };
  expect(ids(activityThreads(tabs, names, "", unread, quiet))).toEqual(["u"]);
  expect(ids(activityThreads(tabs, names, "", off, quiet))).toEqual(["u", "d", "r"]);
});

it("groups by status in a fixed order and hides empty groups", () => {
  const tabs = [src("w", {}, 9), src("d", { status: "done" }, 8), src("n", { status: "needs-you" }, 1), src("n2", { status: "needs-you" }, 7)];
  const groups = activityThreads(tabs, names, "", { ...off, groupBy: "status" });
  expect(groups.map((g) => [g.kind, g.key, g.threads.map((t) => t.tab.id)])).toEqual([
    ["status", "needs-you", ["n2", "n"]],
    ["status", "working", ["w"]],
    ["status", "done", ["d"]],
  ]);
  expect(STATUS_ORDER[0]).toBe("needs-you");
  expect(activityThreads(tabs, names, "nomatch", { ...off, groupBy: "status" })).toEqual([]);
});

it("groups by agent in the order of each agent's newest thread", () => {
  const tabs = [src("c1", {}, 5), src("x1", { profileId: "codex" }, 9), src("c2", {}, 1)];
  const groups = activityThreads(tabs, names, "", { ...off, groupBy: "agent" });
  expect(groups.map((g) => [g.key, g.worktree, g.name, g.threads.map((t) => t.tab.id)])).toEqual([
    ["codex", null, null, ["x1"]],
    ["claude", null, null, ["c1", "c2"]],
  ]);
});

it("no match is an empty list; an unknown worktree shows its path", () => {
  expect(activityThreads([], names, "", off)).toEqual([]);
  const out = activityThreads([src("x", { worktree: "/zzz" }, 1)], names, "", off);
  expect(out[0]!.threads[0]).toMatchObject({ worktreeName: "/zzz", branch: null });
});

it("hasAgentThreads counts idle and ended agent tabs, not shells", () => {
  expect(hasAgentThreads([])).toBe(false);
  expect(hasAgentThreads([src("s", { agent: false }, 1)])).toBe(false);
  expect(hasAgentThreads([src("i", { status: "idle" }, null)])).toBe(true);
  expect(hasAgentThreads([src("e", { status: "exited" }, null)])).toBe(true);
});
