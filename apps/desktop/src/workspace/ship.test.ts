import { describe, expect, it } from "vitest";
import type { Check, PrView, ShipView } from "@/api";
import { checksSummary, shipAction } from "./ship";

const commit = { id: "a", author: "x", time: 1, message: "m" };

function ship(over: { ahead?: number; behind?: number; upstream?: boolean; commits?: number } & Partial<Omit<ShipView, "upstream">> = {}): ShipView {
  const { ahead = 0, behind = 0, upstream = true, commits = 1, ...rest } = over;
  return {
    branch: "oak",
    base: "main",
    remote: "origin",
    upstream: upstream ? { remote: "origin", branch: "oak", id: "b", ahead, behind, rewritten: false } : null,
    headPushed: ahead === 0,
    atStart: false,
    range: { mergeBase: "m", added: 1, removed: 0, commits: Array(commits).fill(commit), truncated: false },
    rangeBase: "main",
    aheadOfBase: commits > 0,
    ...rest,
  };
}

const pr = (state: PrView["state"]): PrView => ({ number: 1, url: "u", state, title: "t", base: "main", head: "oak" });
const check = (bucket: Check["bucket"]): Check => ({ name: "n", workflow: null, bucket, link: null });

describe("shipAction", () => {
  it("never offers create_pr while the pull request is unknown", () => {
    expect(shipAction({ checked: 0, ship: ship(), pr: undefined })).toBe("none");
    expect(shipAction({ checked: 0, ship: ship(), pr: null })).toBe("create_pr");
  });
  it("commit wins over everything", () => {
    expect(shipAction({ checked: 1, ship: ship({ ahead: 1, behind: 1 }), pr: null })).toBe("commit");
    expect(shipAction({ checked: 2, ship: null, pr: null })).toBe("commit");
  });
  it("none without ship, branch or remote", () => {
    expect(shipAction({ checked: 0, ship: null, pr: null })).toBe("none");
    expect(shipAction({ checked: 0, ship: ship({ branch: null }), pr: null })).toBe("none");
    expect(shipAction({ checked: 0, ship: ship({ remote: null, upstream: false }), pr: null })).toBe("none");
  });
  it("publish without upstream", () => {
    expect(shipAction({ checked: 0, ship: ship({ upstream: false }), pr: null })).toBe("publish");
  });
  it("diverged when ahead and behind", () => {
    expect(shipAction({ checked: 0, ship: ship({ ahead: 1, behind: 1 }), pr: null })).toBe("diverged");
  });
  it("pull when behind", () => {
    expect(shipAction({ checked: 0, ship: ship({ behind: 2 }), pr: null })).toBe("pull");
  });
  it("push when ahead", () => {
    expect(shipAction({ checked: 0, ship: ship({ ahead: 1 }), pr: null })).toBe("push");
  });
  it("create_pr with commits and no PR", () => {
    expect(shipAction({ checked: 0, ship: ship(), pr: null })).toBe("create_pr");
    expect(shipAction({ checked: 0, ship: ship({ commits: 0 }), pr: null })).toBe("none");
    // Counted against the upstream the range is empty once pushed; the work over the base still counts.
    expect(shipAction({ checked: 0, ship: ship({ commits: 0, rangeBase: "origin/oak", aheadOfBase: true }), pr: null })).toBe("create_pr");
  });
  it("open_pr when a PR is open", () => {
    expect(shipAction({ checked: 0, ship: ship(), pr: pr("open") })).toBe("open_pr");
    expect(shipAction({ checked: 0, ship: ship(), pr: pr("draft") })).toBe("open_pr");
  });
  it("none when merged and up to date", () => {
    expect(shipAction({ checked: 0, ship: ship(), pr: pr("merged") })).toBe("none");
    expect(shipAction({ checked: 0, ship: ship(), pr: pr("closed") })).toBe("none");
  });
});

describe("checksSummary", () => {
  it("fail beats pending beats pass", () => {
    expect(checksSummary([])).toBeNull();
    expect(checksSummary([check("pass"), check("skipping")])).toBe("pass");
    expect(checksSummary([check("pass"), check("pending")])).toBe("pending");
    expect(checksSummary([check("pending"), check("fail"), check("pass")])).toBe("fail");
    expect(checksSummary([check("cancel")])).toBe("fail");
  });
});

describe("shipAction with a pull policy", () => {
  const split = ship({ ahead: 1, behind: 1 });
  it("keeps diverged for ff-only, the default", () => {
    expect(shipAction({ checked: 0, ship: split, pr: null })).toBe("diverged");
    expect(shipAction({ checked: 0, ship: split, pr: null, policy: "ff-only" })).toBe("diverged");
  });
  it("pulls a split history under merge, rebase and git-config", () => {
    for (const policy of ["merge", "rebase", "git-config"] as const) {
      expect(shipAction({ checked: 0, ship: split, pr: null, policy })).toBe("pull");
    }
  });
  it("stays diverged when the remote only has older copies, whatever the policy", () => {
    const s = ship({ ahead: 1, behind: 1 });
    s.upstream = { ...s.upstream!, rewritten: true };
    expect(shipAction({ checked: 0, ship: s, pr: null, policy: "merge" })).toBe("diverged");
  });
});
