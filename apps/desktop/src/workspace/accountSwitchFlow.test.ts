import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import type { SwitchRunning } from "@/api";
import { Sessions, type Tab } from "./sessions";
import { restartTabs, watchAccountSwitch, type PendingSwitch } from "./accountSwitchFlow";

const WT = "/demo/wt/xdev-oak";
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("account switch flow", () => {
  let sessions: Sessions | null = null;
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    sessions?.dispose();
    sessions = null;
  });

  async function setup(policy: SwitchRunning) {
    const api = createMockApi({});
    await api.ptyApprove("claude", null);
    await api.agentsSettingsPut({ accountSwitch: policy });
    const live = (sessions = new Sessions(api));
    const notify = vi.fn();
    const ask = vi.fn<(p: PendingSwitch) => void>();
    const watcher = watchAccountSwitch({ api, sessions: live, notify, ask });
    stop = watcher.stop;
    await tick();
    // An agent tab that follows the active account (claude-2), with a session of its own.
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
    return { api, live, notify, ask, agent };
  }
  const only = (live: Sessions): Tab[] => live.tabs(WT);

  it("Keep leaves the tabs alone", async () => {
    const { api, live, ask, agent } = await setup("keep");
    const tab = await agent();
    await api.accountActivate("claude", "claude-3");
    await tick();
    expect(ask).not.toHaveBeenCalled();
    expect(only(live).map((t) => t.id)).toEqual([tab.id]);
  });

  it("Restart carries the session then restarts every affected tab under the new account", async () => {
    const { api, live, ask, agent } = await setup("restart");
    const carry = vi.spyOn(api, "accountCarrySession");
    const a = await agent("s-a");
    const b = await agent("s-b");
    await api.accountActivate("claude", "claude-3");
    await tick();
    expect(ask).not.toHaveBeenCalled();
    expect(carry.mock.calls.map((c) => [c[1], c[2], c[3], c[4]])).toEqual([["claude-2", "claude-3", "s-a", WT], ["claude-2", "claude-3", "s-b", WT]]);
    const now = only(live);
    expect(now).toHaveLength(2);
    expect(now.map((t) => t.id)).not.toContain(a.id);
    expect(now.map((t) => t.resumeOf)).toEqual(["s-a", "s-b"]);
    expect(now.every((t) => t.account === "claude-3" && t.accountSource === "active")).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it("does not touch shells, tabs with their own account or other providers", async () => {
    const { api, live, agent } = await setup("restart");
    const own = live.open(WT, "claude", "claude-3");
    const info = await own.client.start(WT, "claude", 80, 24, () => {}, "claude-3");
    live.noteStarted(own.id, info);
    const shell = live.open(WT, "shell");
    const mine = await agent();
    await api.accountActivate("claude", "claude-3");
    await tick();
    const ids = only(live).map((t) => t.id);
    expect(ids).toContain(own.id);
    expect(ids).toContain(shell.id);
    expect(ids).not.toContain(mine.id);
    await api.accountActivate("codex", "codex-1");
    await tick();
    expect(only(live).map((t) => t.id)).toEqual(expect.arrayContaining([own.id, shell.id]));
  });

  it("Ask hands the affected tabs to the dialog and restarts nothing yet", async () => {
    const { api, live, ask, agent } = await setup("ask");
    const a = await agent();
    await api.accountActivate("claude", "claude-3");
    await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ provider: "claude", from: "claude-2", to: "claude-3", tabIds: [a.id] });
    expect(only(live).map((t) => t.id)).toEqual([a.id]);
  });

  it("Ask marks a working tab so the dialog can leave it unticked", async () => {
    const { api, live, ask, agent } = await setup("ask");
    const busy = await agent("s");
    api.__hook(busy.id, "prompt");
    await api.accountActivate("claude", "claude-3");
    await tick();
    expect(live.tab(busy.id)!.status).toBe("working");
    expect(ask.mock.calls[0][0].tabIds).toEqual([busy.id]);
  });

  it("Ask says nothing when no tab is affected", async () => {
    const { api, ask } = await setup("ask");
    await api.accountActivate("claude", "claude-3");
    await tick();
    expect(ask).not.toHaveBeenCalled();
  });

  it("going back to the CLI default is a switch too", async () => {
    const { api, live, agent } = await setup("restart");
    await agent();
    await api.accountActivate("claude", null);
    await tick();
    const [now] = only(live);
    expect(now.accountSource).toBe("active");
    expect(now.account).toBeNull();
  });

  it("adding an account, or activating the one already active, is no switch", async () => {
    const { api, ask, agent } = await setup("ask");
    await agent();
    await api.addAccount("extra", "claude", "/demo/accounts/extra");
    await api.accountActivate("claude", "claude-2");
    await tick();
    expect(ask).not.toHaveBeenCalled();
  });

  it("a failed carry restarts that tab fresh and says so", async () => {
    const { api, live, notify, agent } = await setup("restart");
    vi.spyOn(api, "accountCarrySession").mockRejectedValueOnce({ code: "session_missing" });
    const a = await agent("gone");
    const b = await agent("kept");
    await api.accountActivate("claude", "claude-3");
    await tick();
    const [first, second] = only(live);
    expect(first).toMatchObject({ resumeOf: null, agentSession: null, account: "claude-3" });
    expect(second.resumeOf).toBe("kept");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("accounts.switch.carryFailed");
    expect([a.id, b.id]).not.toContain(first.id);
  });

  it("a tab without a session id restarts without a carry", async () => {
    const { api, live, agent } = await setup("restart");
    const carry = vi.spyOn(api, "accountCarrySession");
    await agent(null);
    await api.accountActivate("claude", "claude-3");
    await tick();
    expect(carry).not.toHaveBeenCalled();
    expect(only(live)[0].account).toBe("claude-3");
  });

  it("restartTabs skips a tab that is gone and keeps the pin", async () => {
    const { api, live, agent } = await setup("ask");
    const a = await agent("s");
    live.setPinned(a.id, true);
    const pending: PendingSwitch = { provider: "claude", from: "claude-2", to: "claude-2", tabIds: [a.id, "gone"] };
    await restartTabs({ api, sessions: live, notify: vi.fn() }, pending, [a.id, "gone"]);
    expect(only(live)).toHaveLength(1);
    expect(only(live)[0].pinned).toBe(true);
  });
});
