import { describe, expect, it } from "vitest";
import type { PendingQuestion } from "@/conversation/questionStore";
import { ASK_DETAIL, detail } from "@/conversation/fixtures/hookDetails";
import { NO_NEEDS, agentOf, needsDot, selectNeedsYou, sessionState } from "./needsYou";
import type { Tab } from "./sessions";

let n = 0;
const tab = (over: Partial<Tab>): Tab =>
  ({ id: `t${++n}`, worktree: "/w/oak", agent: true, status: "idle", cli: "claude", unread: false, unreadAt: null, unreadReason: null, openedAt: 1, ...over }) as Tab;

describe("selectNeedsYou", () => {
  it("is empty without a waiting agent tab", () => {
    expect(selectNeedsYou([])).toBe(NO_NEEDS);
    expect(selectNeedsYou([tab({ status: "working" }), tab({ status: "done" }), tab({ status: "idle" })])).toBe(NO_NEEDS);
  });

  it("takes agent tabs that need the person or failed, not plain shells or sleeping tabs", () => {
    const ask = tab({ status: "needs-you" });
    const failed = tab({ status: "failed" });
    const shell = tab({ status: "needs-you", agent: false });
    const asleep = tab({ status: "needs-you", asleep: true });
    const needs = selectNeedsYou([ask, failed, shell, asleep]);
    expect(needs.entries.map((e) => e.tab.id)).toEqual([ask.id, failed.id]);
    expect(needs.count).toBe(2);
  });

  it("puts the longest wait first", () => {
    const late = tab({ status: "needs-you", statusAt: 300 });
    const early = tab({ status: "failed", statusAt: 100 });
    const mid = tab({ status: "needs-you", statusAt: 200 });
    expect(selectNeedsYou([late, early, mid]).entries.map((e) => e.since)).toEqual([100, 200, 300]);
  });

  it("dates a wait by the status change, then the unread time, then the opening", () => {
    const [a, b, c] = selectNeedsYou([
      tab({ status: "needs-you", statusAt: 50, unreadAt: 40, openedAt: 1 }),
      tab({ status: "needs-you", unreadAt: 40, openedAt: 2 }),
      tab({ status: "needs-you", openedAt: 3 }),
    ]).entries;
    expect([a.since, b.since, c.since]).toEqual([3, 40, 50]);
  });

  it("counts per worktree", () => {
    const needs = selectNeedsYou([
      tab({ status: "needs-you", worktree: "/w/oak", statusAt: 1 }),
      tab({ status: "failed", worktree: "/w/oak", statusAt: 2 }),
      tab({ status: "needs-you", worktree: "/w/elm", statusAt: 3 }),
    ]);
    expect(needs.byWorktree).toEqual({ "/w/oak": 2, "/w/elm": 1 });
    expect(needs.worktrees).toEqual(["/w/oak", "/w/elm"]);
  });

  it("reads the kind and the words from the tab's question", () => {
    const asked = tab({ status: "needs-you" });
    const tool = tab({ status: "needs-you" });
    const bare = tab({ status: "needs-you" });
    const failed = tab({ status: "failed" });
    const questions: Record<string, PendingQuestion> = {
      [asked.id]: { source: "hook", detail: ASK_DETAIL, text: null, seq: 1 },
      [tool.id]: { source: "hook", detail: detail({ toolName: "Bash", message: "Run the tests" }), text: null, seq: 2 },
      [failed.id]: { source: "hook", detail: ASK_DETAIL, text: null, seq: 3 },
    };
    const kinds = selectNeedsYou([asked, tool, bare, failed], (id) => questions[id] ?? null).entries.map((e) => [e.kind, e.ask]);
    expect(kinds).toEqual([
      ["question", "Which database should the cache use?"],
      ["approval", "Run the tests"],
      ["approval", null],
      ["failed", null],
    ]);
  });

  it("drops a transcript question while the tab needs the person (it holds only at the prompt)", () => {
    const t = tab({ status: "needs-you" });
    const needs = selectNeedsYou([t], () => ({ source: "transcript", detail: null, text: "Which one?", seq: 1 }));
    expect(needs.entries[0]).toMatchObject({ kind: "approval", ask: null });
  });
});

describe("needsDot", () => {
  it("shows needs-you before failed, and nothing for a quiet worktree", () => {
    const needs = selectNeedsYou([
      tab({ status: "failed", worktree: "/w/oak" }),
      tab({ status: "needs-you", worktree: "/w/oak" }),
      tab({ status: "failed", worktree: "/w/elm" }),
    ]);
    expect(needsDot(needs, "/w/oak")).toBe("needs-you");
    expect(needsDot(needs, "/w/elm")).toBe("failed");
    expect(needsDot(needs, "/w/ash")).toBeNull();
  });
});

describe("design system mapping", () => {
  it("maps the CLI to an agent chip and needs-you to waiting", () => {
    expect(agentOf({ cli: "codex" })).toBe("codex");
    expect(agentOf({ cli: null })).toBe("custom");
    expect(sessionState("needs-you")).toBe("waiting");
    expect(sessionState("failed")).toBe("failed");
  });
});
