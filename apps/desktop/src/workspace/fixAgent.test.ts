import { afterEach, expect, it, vi } from "vitest";
import { createMockApi, type Api, type GitSettings } from "@/api";
import { DEFAULT_GIT_SETTINGS, DEMO_WORKSPACE } from "@/mockWorkspace";
import { FIX_BASE_PROMPTS } from "@/settings/recipes";
import { pastePrompt } from "./agentPrompt";
import { sendFix } from "./fixAgent";
import type { Sessions, Tab } from "./sessions";

afterEach(() => vi.useRealTimers());

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, worktree: "/w", profileId: "claude", account: null, permissions: "ask", agent: true, status: "idle", cli: "claude", unread: false, unreadAt: null, unreadReason: null, title: null, renamed: false, resumeOf: null, agentSession: null, openedAt: 0, pinned: false, color: "none", client: { input: vi.fn(async () => {}) } as never, ...over };
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
