import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { ownAccount, runAccount, Sessions, type Tab } from "./sessions";
import { restartTabs, type PendingSwitch } from "./accountSwitchFlow";

const WT = "/demo/wt/xdev-oak";
// What the terminal view does for a restarted tab: starts its pty, which reports the account it got.
const boot = async (live: Sessions, running: readonly string[] = []) => {
  for (const t of live.tabs(WT).filter((x) => !running.includes(x.id))) live.noteStarted(t.id, await t.client.start(WT, "claude", 80, 24, () => {}, ownAccount(t)));
};
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("account switch flow", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  async function setup() {
    const api = createMockApi({});
    await api.ptyApprove("claude", null);
    const live = (sessions = new Sessions(api));
    const notify = vi.fn();
    // An agent tab started on the default account (claude-2), with a session of its own.
    const agent = async (session: string | null = "sess-1") => {
      const tab = live.open(WT, "claude");
      const info = await tab.client.start(WT, "claude", 80, 24, () => {});
      live.noteStarted(tab.id, info);
      if (session) {
        api.__hook(tab.id, "prompt", undefined, session);
        api.__hook(tab.id, "turn-done");
      }
      return live.tab(tab.id)!;
    };
    const move = (ids: string[], to: string | null = "claude-3", from: string | null = "claude-2") =>
      restartTabs({ api, sessions: live, notify }, { provider: "claude", from, to, tabIds: ids }, ids);
    return { api, live, notify, agent, move };
  }
  const only = (live: Sessions): Tab[] => live.tabs(WT);

  it("a new default leaves running tabs on the account they started with", async () => {
    const { api, live, agent } = await setup();
    const tab = await agent();
    expect(tab.account).toBe("claude-2");
    await api.accountActivate("claude", "claude-3");
    await tick();
    expect(only(live).map((t) => [t.id, t.account])).toEqual([[tab.id, "claude-2"]]);
    // Its next start keeps that account too.
    expect(runAccount(live.tab(tab.id)!)).toBe("claude-2");
    // The running terminal's own start account does not change once the pty reports it.
    expect(ownAccount(live.tab(tab.id)!)).toBeNull();
  });

  it("two tabs of one provider run on different accounts at once", async () => {
    const { api, live, agent } = await setup();
    const a = await agent("s-a");
    await api.accountActivate("claude", "claude-3");
    const b = await agent("s-b");
    expect([live.tab(a.id)!.account, live.tab(b.id)!.account]).toEqual(["claude-2", "claude-3"]);
  });

  it("carries the session then restarts the tab under the new account, pinned", async () => {
    const { api, live, agent, move } = await setup();
    const carry = vi.spyOn(api, "accountCarrySession");
    const a = await agent("s-a");
    const b = await agent("s-b");
    await move([a.id]);
    expect(carry.mock.calls.map((c) => [c[1], c[2], c[3], c[4]])).toEqual([["claude-2", "claude-3", "s-a", WT]]);
    await boot(live, [b.id]);
    const now = only(live);
    expect(now).toHaveLength(2);
    expect(now.map((t) => t.id)).not.toContain(a.id);
    expect(now.map((t) => t.id)).toContain(b.id);
    const moved = now.find((t) => t.id !== b.id)!;
    expect(moved).toMatchObject({ resumeOf: "s-a", account: "claude-3", accountSource: "tab" });
    expect(live.tab(b.id)!.account).toBe("claude-2");
  });

  it("moving to the CLI's own home is a switch too", async () => {
    const { live, agent, move } = await setup();
    const a = await agent();
    await move([a.id], null);
    const [now] = only(live);
    expect(now.account).toBeNull();
  });

  it("a failed carry restarts that tab fresh and says so", async () => {
    const { api, live, notify, agent, move } = await setup();
    vi.spyOn(api, "accountCarrySession").mockRejectedValueOnce({ code: "session_missing" });
    const a = await agent("gone");
    const b = await agent("kept");
    await move([a.id, b.id]);
    await boot(live);
    const [first, second] = only(live);
    expect(first).toMatchObject({ resumeOf: null, agentSession: null, account: "claude-3" });
    expect(second.resumeOf).toBe("kept");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("accounts.switch.carryFailed");
    expect([a.id, b.id]).not.toContain(first.id);
  });

  it("a tab that only has the session it resumed still carries that session", async () => {
    const carry = vi.fn(async () => {});
    const restartAs = vi.fn();
    const tab = { id: "t", worktree: WT, title: null, profileId: "claude", agentSession: null, resumeOf: "resumed-1" };
    const deps = { api: { accountCarrySession: carry } as never, sessions: { tab: () => tab, restartAs } as never, notify: vi.fn() };
    await restartTabs(deps, { provider: "claude", from: "claude-2", to: "claude-3", tabIds: ["t"] }, ["t"]);
    expect(carry).toHaveBeenCalledWith("claude", "claude-2", "claude-3", "resumed-1", WT);
    expect(restartAs).toHaveBeenCalledWith("t", "claude-3", false);
  });

  it("a tab without a session id restarts without a carry", async () => {
    const { api, live, agent, move } = await setup();
    const carry = vi.spyOn(api, "accountCarrySession");
    const a = await agent(null);
    await move([a.id]);
    expect(carry).not.toHaveBeenCalled();
    await boot(live);
    expect(only(live)[0].account).toBe("claude-3");
  });

  it("restartTabs skips a tab that is gone and keeps the pin", async () => {
    const { api, live, agent } = await setup();
    const a = await agent("s");
    live.setPinned(a.id, true);
    const pending: PendingSwitch = { provider: "claude", from: "claude-2", to: "claude-2", tabIds: [a.id, "gone"] };
    await restartTabs({ api, sessions: live, notify: vi.fn() }, pending, [a.id, "gone"]);
    expect(only(live)).toHaveLength(1);
    expect(only(live)[0].pinned).toBe(true);
  });
});
