import { describe, expect, it } from "vitest";
import type { ShipView } from "@/api";
import { forkSyncText, shipMenu, type MenuEntry, type MenuInput } from "./shipMenu";

function view(over: { ahead?: number; behind?: number; rewritten?: boolean; upstream?: boolean } & Partial<Omit<ShipView, "upstream">> = {}): ShipView {
  const { ahead = 0, behind = 0, rewritten = false, upstream = true, ...rest } = over;
  return {
    branch: "oak",
    base: "origin/main",
    remote: "origin",
    upstream: upstream ? { remote: "origin", branch: "oak", id: "b", ahead, behind, rewritten } : null,
    headPushed: ahead === 0,
    atStart: false,
    range: null,
    rangeBase: "origin/main",
    aheadOfBase: true,
    hasForkUpstream: false,
    ...rest,
  };
}

const input = (over: Partial<MenuInput> = {}): MenuInput => ({
  ship: view(),
  action: "none",
  checked: 1,
  hasMessage: true,
  busy: false,
  baseRemote: true,
  hasPr: false,
  ...over,
});

const ids = (m: MenuEntry[]) => m.map((e) => (e.separator ? "-" : e.id));
const item = (m: MenuEntry[], id: string) => {
  const e = m.find((x) => !x.separator && x.id === id);
  if (!e || e.separator) throw new Error(`no ${id}`);
  return e;
};

describe("shipMenu", () => {
  it("lists the entries in the reference order", () => {
    expect(ids(shipMenu(input()))).toEqual(["commit_push", "commit_sync", "-", "pull", "fast_forward", "sync", "rebase", "fetch", "force"]);
  });

  it("offers Push before pull request only for push or publish without a pull request", () => {
    expect(ids(shipMenu(input({ action: "push" }))).slice(-2)).toEqual(["-", "push_then_pr"]);
    expect(ids(shipMenu(input({ action: "publish" })))).toContain("push_then_pr");
    expect(ids(shipMenu(input({ action: "push", hasPr: true })))).not.toContain("push_then_pr");
    expect(ids(shipMenu(input({ action: "pull" })))).not.toContain("push_then_pr");
  });

  it("disables the combos for each missing precondition", () => {
    for (const over of [{ checked: 0 }, { hasMessage: false }, { busy: true }, { ship: view({ branch: null }) }, { ship: view({ remote: null }) }]) {
      const m = shipMenu(input(over));
      expect(item(m, "commit_push").disabled, JSON.stringify(over)).toBe(true);
      expect(item(m, "commit_sync").disabled).toBe(true);
    }
    expect(item(shipMenu(input()), "commit_push").disabled).toBe(false);
  });

  it("swaps Commit & push for a force push and disables Commit & sync when rewritten", () => {
    const m = shipMenu(input({ ship: view({ ahead: 1, behind: 1, rewritten: true }) }));
    expect(item(m, "commit_push").label.key).toBe("ship.combo.forcePush");
    expect(item(m, "commit_push").tooltip?.key).toBe("ship.combo.forcePush.tip");
    expect(item(m, "commit_sync").disabled).toBe(true);
    expect(item(m, "commit_sync").tooltip?.key).toBe("ship.combo.sync.rewrittenTip");
  });

  it("words the push tooltip by how far behind the remote is", () => {
    expect(item(shipMenu(input()), "commit_push").tooltip?.key).toBe("ship.combo.push.tip");
    expect(item(shipMenu(input({ ship: view({ behind: 2 }) })), "commit_push").tooltip?.key).toBe("ship.combo.push.behindTip");
  });

  it("counts in the Fast-forward and Sync labels", () => {
    const m = shipMenu(input({ ship: view({ ahead: 1, behind: 3 }) }));
    expect(item(m, "fast_forward").label.params).toEqual({ count: 3 });
    expect(item(m, "sync").label.params).toEqual({ behind: 3, ahead: 1 });
  });

  it("enables Fast-forward only when the remote has new commits and is not a rewrite", () => {
    expect(item(shipMenu(input({ ship: view({ behind: 1 }) })), "fast_forward").disabled).toBe(false);
    expect(item(shipMenu(input()), "fast_forward").disabled).toBe(true);
    const rewritten = item(shipMenu(input({ ship: view({ ahead: 1, behind: 1, rewritten: true }) })), "fast_forward");
    expect(rewritten.disabled).toBe(true);
    expect(rewritten.tooltip?.key).toBe("ship.update.ff.rewrittenTip");
  });

  it("names the base in Rebase and disables it for a base that is not remote", () => {
    const ok = item(shipMenu(input()), "rebase");
    expect(ok.label).toEqual({ key: "ship.update.rebase", params: { ref: "origin/main" } });
    expect(ok.disabled).toBe(false);
    const local = item(shipMenu(input({ baseRemote: false })), "rebase");
    expect(local.disabled).toBe(true);
    expect(local.tooltip?.key).toBe("ship.update.rebase.noRemoteTip");
    expect(item(shipMenu(input({ ship: view({ base: "" }) })), "rebase").label.key).toBe("ship.update.rebaseBase");
  });

  it("disables Force push without a remote-tracking commit", () => {
    expect(item(shipMenu(input({ ship: view({ upstream: false }) })), "force").disabled).toBe(true);
    expect(item(shipMenu(input()), "force").disabled).toBe(false);
  });
});

describe("sync fork", () => {
  const ids = (list: MenuEntry[]) => list.flatMap((e) => (e.separator ? [] : [e.id]));

  it("sync_fork shown only with hasForkUpstream", () => {
    expect(ids(shipMenu(input()))).not.toContain("sync_fork");
    const entries = shipMenu(input({ ship: view({ hasForkUpstream: true }) }));
    const sync = entries.find((e) => !e.separator && e.id === "sync_fork");
    expect(sync).toMatchObject({ label: { key: "ship.menu.syncFork" }, disabled: false });
    expect(shipMenu(input({ ship: view({ hasForkUpstream: true }), busy: true })).find((e) => !e.separator && e.id === "sync_fork")).toMatchObject({ disabled: true });
    // Detached or without a remote of its own it is still offered: it moves origin, not the branch.
    expect(ids(shipMenu(input({ ship: view({ hasForkUpstream: true, branch: null }) })))).toContain("sync_fork");
  });

  it("words each result", () => {
    const base = { reason: null, branch: "main", ahead: 0, behind: 0 } as const;
    expect(forkSyncText({ ...base, status: "up_to_date" })).toEqual({ key: "ship.syncFork.upToDate" });
    expect(forkSyncText({ ...base, status: "synced", behind: 3 })).toEqual({ key: "ship.syncFork.synced", params: { count: 3 } });
    expect(forkSyncText({ ...base, status: "blocked", reason: "diverged", ahead: 1 })).toEqual({ key: "ship.syncFork.diverged", params: { branch: "main" } });
    expect(forkSyncText({ ...base, status: "blocked", reason: "missing_upstream_default_branch", branch: null })).toEqual({ key: "ship.syncFork.noDefault" });
    expect(forkSyncText({ ...base, status: "blocked", reason: "missing_origin_branch", branch: "next" })).toEqual({ key: "ship.syncFork.noOriginBranch", params: { branch: "next" } });
    expect(forkSyncText({ ...base, status: "blocked", reason: "missing_upstream", branch: null })).toEqual({ key: "ship.syncFork.noRemotes" });
    expect(forkSyncText({ ...base, status: "blocked", reason: "missing_origin", branch: null })).toEqual({ key: "ship.syncFork.noRemotes" });
  });
});
