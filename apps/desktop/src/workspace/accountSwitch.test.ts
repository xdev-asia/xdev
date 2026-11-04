import { afterEach, describe, expect, it } from "vitest";
import { createMockApi } from "@/mockApi";
import type { AccountSource } from "@/api";
import { ownAccount, Sessions, type Tab } from "./sessions";
import { affectedTabs } from "./accountSwitch";

const WT = "/demo/wt/xdev-oak";
// What the terminal view does on mount: starts the pty with the account the tab itself picked.
const start = (t: Tab) => t.client.start(WT, "claude", 80, 24, () => {}, ownAccount(t));

const tab = (over: Partial<Tab>): Tab => ({ id: "t", worktree: WT, profileId: "claude", account: "claude-2", accountSource: "active", agent: true, cli: "claude", ...over }) as Tab;

describe("affectedTabs", () => {
  it("keeps only agent tabs that follow the active account of that provider and the old account", () => {
    const hit = tab({ id: "hit" });
    const tabs = [
      hit,
      tab({ id: "shell", profileId: "shell", agent: false, cli: null, account: null, accountSource: null }),
      tab({ id: "own", accountSource: "tab" }),
      tab({ id: "profile", accountSource: "profile" }),
      tab({ id: "other-account", account: "claude-3" }),
      tab({ id: "codex", profileId: "codex", cli: "codex" }),
      tab({ id: "unknown", accountSource: null }),
    ];
    expect(affectedTabs(tabs, "claude", "claude-2")).toEqual([hit]);
  });

  it("matches the CLI default (null) as the old account", () => {
    const t = tab({ account: null });
    expect(affectedTabs([t], "claude", null)).toEqual([t]);
    expect(affectedTabs([t], "claude", "claude-2")).toEqual([]);
  });
});

describe("Sessions keep the account source", () => {
  let sessions: Sessions | null = null;
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  async function started(api = createMockApi({}), source: { account: string | null; source: AccountSource | null } = { account: null, source: null }) {
    await api.ptyApprove("claude", null);
    const live = (sessions = new Sessions(api));
    const t = live.open(WT, "claude", source.account);
    const info = await start(t);
    live.noteStarted(t.id, info);
    return { live, tab: live.tab(t.id)! };
  }

  it("noteStarted records where the account came from", async () => {
    const { tab: t } = await started();
    expect(t).toMatchObject({ account: "claude-2", accountSource: "active" });
  });

  it("restart of a tab that follows the active account still follows it", async () => {
    const api = createMockApi({});
    const { live, tab: t } = await started(api);
    await api.accountActivate("claude", "claude-3");
    const next = live.restart(t.id)!;
    const info = await start(next);
    live.noteStarted(next.id, info);
    expect(live.tab(next.id)).toMatchObject({ account: "claude-3", accountSource: "active" });
  });

  it("restartAs sets the new account and keeps the source", async () => {
    const api = createMockApi({});
    const { live, tab: t } = await started(api);
    await api.accountActivate("claude", "claude-3");
    const next = live.restartAs(t.id, "claude-3")!;
    expect(next).toMatchObject({ account: "claude-3", accountSource: "active", pinned: t.pinned });
    const info = await start(next);
    live.noteStarted(next.id, info);
    expect(live.tab(next.id)).toMatchObject({ account: "claude-3", accountSource: "active" });
    expect(live.restartAs("gone", "claude-3")).toBeNull();
  });

  it("restart keeps a tab's own account as its own", async () => {
    const api = createMockApi({});
    const { live, tab: t } = await started(api, { account: "claude-3", source: "tab" });
    expect(t.accountSource).toBe("tab");
    const next = live.restart(t.id)!;
    expect(next).toMatchObject({ account: "claude-3", accountSource: "tab" });
    const info = await start(next);
    live.noteStarted(next.id, info);
    expect(live.tab(next.id)).toMatchObject({ account: "claude-3", accountSource: "tab" });
  });

  it("a closed tab that followed the active account comes back following it", async () => {
    const api = createMockApi({});
    const { live, tab: t } = await started(api);
    await live.close(t.id);
    const again = live.reopenClosed(WT)!;
    const info = await start(again);
    live.noteStarted(again.id, info);
    expect(live.tab(again.id)).toMatchObject({ accountSource: "active" });
  });

  it("the snapshot leaves out an account the tab did not pick", async () => {
    const { live } = await started();
    const snap = live.snapshot();
    const [one] = Object.values(Object.values(snap.worktrees)[0].tabs);
    expect(one).toMatchObject({ kind: "terminal", account: null });
  });
});
