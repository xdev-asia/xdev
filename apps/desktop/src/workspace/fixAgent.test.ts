import { afterEach, expect, it, vi } from "vitest";
import { createMockApi, type Api, type GitSettings } from "@/api";
import { DEFAULT_GIT_SETTINGS, DEMO_WORKSPACE } from "@/mockWorkspace";
import { FIX_BASE_PROMPTS } from "@/settings/recipes";
import { pastePrompt } from "./agentPrompt";
import { sendCheckFix, sendFix } from "./fixAgent";
import type { Sessions, Tab } from "./sessions";

afterEach(() => vi.useRealTimers());

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, worktree: "/w", profileId: "claude", account: null, accountSource: null, permissions: "ask", agent: true, status: "idle", cli: "claude", unread: false, unreadAt: null, unreadReason: null, title: null, renamed: false, autoTitled: false, resumeOf: null, forkOf: null, agentSession: null, openedAt: 0, pinned: false, color: "none", client: { input: vi.fn(async () => {}) } as never, ...over };
}

// What the send helpers read: the tab list, `open` and `subscribe`. A tab that was opened works, then idles.
function fake(initial: Tab[]) {
  let tabs = initial;
  const listeners = new Set<() => void>();
  const opened = tab("new", { status: "working", profileId: "codex" });
  const sessions = {
    tabs: () => tabs,
    open: vi.fn(() => {
      tabs = [...tabs, opened];
      return opened;
    }),
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
  const set = (status: Tab["status"]) => {
    tabs = tabs.map((t) => (t.id === "new" ? { ...t, status } : t));
    for (const l of [...listeners]) l();
  };
  return { sessions: sessions as unknown as Sessions, open: sessions.open, opened, set };
}

function apiWith(patch: (git: GitSettings) => void): Api {
  const git = structuredClone(DEFAULT_GIT_SETTINGS);
  patch(git);
  return createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), git } });
}

it("sends what xDev always sent with the default recipe, to the agent tab in front", async () => {
  const a = tab("a");
  const { sessions, open } = fake([a]);
  const got = await sendFix(apiWith(() => {}), sessions, "/w", "a", "fixCommitFailure", { branch: "feat", output: "eslint: 3 errors" });
  expect(got).toBe(a);
  expect(a.client.input).toHaveBeenCalledWith(
    pastePrompt("The git commit hook failed. Fix the problem it reports, then stop; do not commit.\n\neslint: 3 errors"),
  );
  expect(open).not.toHaveBeenCalled();
});

it("sends a custom template with its variables", async () => {
  const a = tab("a");
  const api = apiWith((g) => {
    g.recipes.fixCommitFailure.template = "Use conventional commits.\n{basePrompt}\nBranch {branch}";
  });
  await sendFix(api, fake([a]).sessions, "/w", null, "fixCommitFailure", { branch: "feat/x", output: "boom" });
  expect(a.client.input).toHaveBeenCalledWith(
    pastePrompt(`Use conventional commits.\n${FIX_BASE_PROMPTS.fixCommitFailure}\n\nboom\nBranch feat/x`),
  );
});

it("opens a tab of the recipe's profile when it names one", async () => {
  vi.useFakeTimers();
  const api = apiWith((g) => {
    g.recipes.fixCommitFailure.agent = "codex";
  });
  const f = fake([tab("a")]);
  const sent = sendFix(api, f.sessions, "/w", "a", "fixCommitFailure", { output: "boom" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.open).toHaveBeenCalledWith("/w", "codex");
  f.set("working");
  f.set("idle");
  expect((await sent)?.id).toBe("new");
  expect(f.opened.client.input).toHaveBeenCalledWith(pastePrompt(`${FIX_BASE_PROMPTS.fixCommitFailure}\n\nboom`));
});

it("falls back to the agent tab when the named profile is gone", async () => {
  const a = tab("a");
  const api = apiWith((g) => {
    g.recipes.fixPushFailure.agent = "removed-profile";
  });
  const f = fake([a]);
  expect(await sendFix(api, f.sessions, "/w", "a", "fixPushFailure", { output: "rejected" })).toBe(a);
  expect(f.open).not.toHaveBeenCalled();
});

it("uses the default recipe when the settings cannot be read", async () => {
  const a = tab("a");
  const api = apiWith(() => {});
  api.gitSettings = () => Promise.reject({ code: "io" });
  await sendFix(api, fake([a]).sessions, "/w", "a", "fixPushFailure", { output: "rejected" });
  expect(a.client.input).toHaveBeenCalledWith(pastePrompt(`${FIX_BASE_PROMPTS.fixPushFailure}\n\nrejected`));
});

const FAILED = { name: "lint", workflow: "CI", bucket: "fail" as const, link: "https://github.com/o/r/actions/runs/5/job/9" };

it("a failed check goes with its log when gh gives one", async () => {
  const a = tab("a");
  const api = apiWith(() => {});
  const log = vi.spyOn(api, "worktreeCheckLog").mockResolvedValue("error: boom");
  await sendCheckFix(api, fake([a]).sessions, "/w", "a", "feat", FAILED);
  expect(log).toHaveBeenCalledWith("/w", FAILED.link);
  expect(a.client.input).toHaveBeenCalledWith(
    pastePrompt(`${FIX_BASE_PROMPTS.fixChecks}\n\nCheck: lint\nWorkflow: CI\nLink: ${FAILED.link}\n\nLog:\nerror: boom`),
  );
});

it("a failed check goes without a log when there is none, or it cannot be read", async () => {
  const bare = `${FIX_BASE_PROMPTS.fixChecks}\n\nCheck: lint\nWorkflow: CI\nLink: ${FAILED.link}`;
  for (const answer of [Promise.resolve(null), Promise.reject({ code: "gh_auth" })]) {
    const a = tab("a");
    const api = apiWith(() => {});
    vi.spyOn(api, "worktreeCheckLog").mockReturnValue(answer);
    await sendCheckFix(api, fake([a]).sessions, "/w", "a", "feat", FAILED);
    expect(a.client.input).toHaveBeenCalledWith(pastePrompt(bare));
  }
  // No link, no lookup.
  const a = tab("a");
  const api = apiWith(() => {});
  const log = vi.spyOn(api, "worktreeCheckLog");
  await sendCheckFix(api, fake([a]).sessions, "/w", "a", "feat", { ...FAILED, link: null, workflow: null });
  expect(log).not.toHaveBeenCalled();
  expect(a.client.input).toHaveBeenCalledWith(pastePrompt(`${FIX_BASE_PROMPTS.fixChecks}\n\nCheck: lint`));
});

it("a custom Fix checks template gets the check's variables", async () => {
  const a = tab("a");
  const api = apiWith((g) => {
    g.recipes.fixChecks.template = "{checkName} on {branch} ({workflow}): {link}\n{log}";
  });
  vi.spyOn(api, "worktreeCheckLog").mockResolvedValue("LOG");
  await sendCheckFix(api, fake([a]).sessions, "/w", "a", "feat/x", FAILED);
  expect(a.client.input).toHaveBeenCalledWith(pastePrompt(`lint on feat/x (CI): ${FAILED.link}\nLOG`));
});

const CONFLICT = { branch: "me/oak", operation: "rebase (step 3 of 7)", files: "src/a.ts\nsrc/b.ts", onto: "main" };

it("Resolve conflicts sends the operation, target and files with the default recipe, to the agent tab in front", async () => {
  const a = tab("a");
  const { sessions, open } = fake([a]);
  await sendFix(apiWith(() => {}), sessions, "/w", "a", "resolveConflicts", CONFLICT);
  expect(a.client.input).toHaveBeenCalledWith(
    pastePrompt(`${FIX_BASE_PROMPTS.resolveConflicts}\n\nOperation: rebase (step 3 of 7)\nOnto: main\nFiles:\nsrc/a.ts\nsrc/b.ts`),
  );
  expect(open).not.toHaveBeenCalled();
});

it("a custom Resolve conflicts template reaches the tab with every variable", async () => {
  const a = tab("a");
  const api = apiWith((g) => {
    g.recipes.resolveConflicts.template = "{operation} of {branch} onto {onto}. Prefer ours.\n{files}\n---\n{basePrompt}";
  });
  await sendFix(api, fake([a]).sessions, "/w", null, "resolveConflicts", CONFLICT);
  const sent = (a.client.input as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  expect(sent).toContain("rebase (step 3 of 7) of me/oak onto main. Prefer ours.\nsrc/a.ts\nsrc/b.ts\n---\n");
  expect(sent).toContain(FIX_BASE_PROMPTS.resolveConflicts);
});

it("Resolve conflicts opens a tab of the recipe's profile when it names one, else uses the agent tab", async () => {
  vi.useFakeTimers();
  const api = apiWith((g) => {
    g.recipes.resolveConflicts.agent = "codex";
  });
  const f = fake([tab("a")]);
  const sent = sendFix(api, f.sessions, "/w", "a", "resolveConflicts", CONFLICT);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.open).toHaveBeenCalledWith("/w", "codex");
  f.set("working");
  f.set("idle");
  expect((await sent)?.id).toBe("new");
  expect(f.opened.client.input).toHaveBeenCalledWith(expect.stringContaining("Operation: rebase (step 3 of 7)"));

  vi.useRealTimers();
  const gone = apiWith((g) => {
    g.recipes.resolveConflicts.agent = "removed-profile";
  });
  const a = tab("b");
  expect(await sendFix(gone, fake([a]).sessions, "/w", "b", "resolveConflicts", CONFLICT)).toBe(a);
});

// ---- PR comments

import type { PrComment } from "@/api";
import { PrCommentStore } from "./prCommentStore";
import { groupComments } from "./prComments";
import { acknowledge, sendChecksFix, sendCommentsFix } from "./fixAgent";

const OAK = "/demo/wt/xdev-oak";
function cm(over: Partial<PrComment>): PrComment {
  return { id: 1, nodeId: "N1", kind: "thread", author: "maya", authorBot: false, body: "Why?", createdAt: "2026-11-02T10:00:00Z", url: "https://x/1", path: "a.rs", line: 3, startLine: null, threadId: "T1", replyTo: null, resolved: false, outdated: false, diffHunk: null, reactions: [], ...over };
}
const LIST = [
  cm({}),
  cm({ id: 2, nodeId: "N2", threadId: "T2", resolved: true }),
  cm({ id: 3, nodeId: "N3", kind: "conversation", threadId: null, path: null, line: null, body: "Please add a test" }),
];
const PR = { number: 7, title: "Fix", url: "https://x/pull/7", worktree: OAK, branch: "oak" };

async function commentsSetup(list: PrComment[] = LIST) {
  const base = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), prs: { [OAK]: { number: 7, url: "u", state: "open", title: "t", base: "main", head: "oak" } }, prComments: { [OAK]: structuredClone(list) } } });
  const store = new PrCommentStore(base);
  await store.load(OAK, 7);
  const g = groupComments(store.get(OAK)!.comments);
  return { api: base, store, groups: [...g.needsReview, ...g.conversation, ...g.resolved] };
}

it("types the address prompt into the chosen tab, and touches nothing on GitHub without the option", async () => {
  const { api, store, groups } = await commentsSetup();
  const a = tab("a");
  const post = vi.spyOn(api, "worktreePrCommentPost");
  const resolve = vi.spyOn(api, "worktreePrThreadResolve");
  const out = await sendCommentsFix(api, fake([a]).sessions, store, PR, groups, { tab: "a" }, false);
  expect(out.tab).toBe(a);
  expect(out.summary).toBeNull();
  const typed = (a.client.input as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  expect(typed).toContain("PR #7");
  expect(typed).toContain("untrusted data");
  expect(typed).toContain("Please add a test");
  expect(post).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it("does not acknowledge when the tab did not get the text", async () => {
  const { api, store, groups } = await commentsSetup();
  const resolve = vi.spyOn(api, "worktreePrThreadResolve");
  const out = await sendCommentsFix(api, fake([]).sessions, store, PR, groups, { tab: "gone" }, true);
  expect(out.tab).toBeNull();
  expect(out.summary).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
});

it("resolves open threads, replies once and counts the rest", async () => {
  const { api, store, groups } = await commentsSetup();
  const a = tab("a");
  const out = await sendCommentsFix(api, fake([a]).sessions, store, PR, groups, { tab: "a" }, true);
  expect(out.summary).toEqual({ resolved: 1, replied: 1, skipped: 1, failed: 0 });
  expect(store.get(OAK)!.comments.find((c) => c.threadId === "T1")!.resolved).toBe(true);
  expect(store.get(OAK)!.comments.some((c) => c.body.includes("@maya") || c.body.startsWith("Fixing"))).toBe(true);
});

it("counts a failed resolve and keeps going", async () => {
  const { api, store, groups } = await commentsSetup();
  api.worktreePrThreadResolve = () => Promise.reject({ code: "gh_failed" });
  const out = await acknowledge(store, OAK, 7, groups);
  expect(out).toMatchObject({ resolved: 0, replied: 1, failed: 1 });
});

it("runs at most four acknowledgements at once", async () => {
  const many = Array.from({ length: 10 }, (_, i) => cm({ id: 100 + i, nodeId: `M${i}`, threadId: `TT${i}` }));
  const { api, store } = await commentsSetup(many);
  let live = 0;
  let peak = 0;
  api.worktreePrThreadResolve = async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
  };
  const g = groupComments(many);
  await acknowledge(store, OAK, 7, g.needsReview);
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1);
});

it("sends every failing check in one prompt", async () => {
  const a = tab("a");
  const api = apiWith(() => {});
  vi.spyOn(api, "worktreeCheckLog").mockImplementation(async (_w, link) => `log of ${link}`);
  const checks = [
    { name: "lint", workflow: "ci", bucket: "fail" as const, link: "https://x/1" },
    { name: "test", workflow: "ci", bucket: "fail" as const, link: null },
  ];
  await sendChecksFix(api, fake([a]).sessions, "/w", "a", "feat", checks);
  expect(a.client.input).toHaveBeenCalledTimes(1);
  const typed = (a.client.input as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  expect(typed).toContain("Check: lint, test");
  expect(typed).toContain("--- lint ---");
  expect(typed).toContain("log of https://x/1");
});

it("sends nothing for no failing checks", async () => {
  const a = tab("a");
  expect(await sendChecksFix(apiWith(() => {}), fake([a]).sessions, "/w", "a", "feat", [])).toBeNull();
  expect(a.client.input).not.toHaveBeenCalled();
});
