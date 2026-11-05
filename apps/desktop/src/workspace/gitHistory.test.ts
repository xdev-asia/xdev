import { describe, expect, it } from "vitest";
import type { CommitRef, LogCommit, RepoLog } from "@/api";
import { clampHistoryHeight, displayRefs, historyRows, OPEN_CAP, rememberOpen, SYNTHETIC_ID } from "./gitHistory";

const c = (id: string, parents: string[], refs: CommitRef[] = []): LogCommit => ({ id, parents, author: "a", email: "e", time: 1, subject: `s ${id}`, body: "", refs });
const branch = (name: string): CommitRef => ({ name, kind: "branch" });
const remote = (name: string): CommitRef => ({ name, kind: "remote" });
const tag = (name: string): CommitRef => ({ name, kind: "tag" });

function log(over: Partial<RepoLog> = {}): RepoLog {
  return {
    commits: [c("h", ["m"]), c("m", ["r"]), c("r", [])],
    head: "h",
    branch: "oak",
    upstream: null,
    base: null,
    mergeBase: "m",
    incoming: false,
    outgoing: false,
    hasMore: false,
    ...over,
  };
}

describe("historyRows", () => {
  it("keeps the log order when nothing is incoming or outgoing", () => {
    expect(historyRows(log()).map((r) => r.key)).toEqual(["h", "m", "r"]);
  });

  it("puts Outgoing changes before HEAD and Incoming changes before the merge base", () => {
    const rows = historyRows(log({ outgoing: true, incoming: true }));
    expect(rows.map((r) => r.key)).toEqual(["outgoing", "h", "incoming", "m", "r"]);
    const [out, , inc] = [rows[0], rows[1], rows[2]];
    expect(out.id).toBe(SYNTHETIC_ID);
    expect(out.boundary).toBe("outgoing");
    expect(out.parents).toEqual(["h"]);
    expect(out.commit).toBeNull();
    expect(inc.id).toBe(SYNTHETIC_ID);
    expect(inc.boundary).toBe("incoming");
    expect(inc.parents).toEqual(["m"]);
  });

  it("adds neither boundary row when the flags are off", () => {
    expect(historyRows(log()).some((r) => r.boundary !== null)).toBe(false);
  });

  it("marks HEAD, the upstream and the base", () => {
    const rows = historyRows(log({ upstream: { name: "origin/oak", id: "m" }, base: { name: "origin/main", id: "r" } }));
    expect(rows.map((r) => r.marks)).toEqual([["head"], ["remote"], ["base"]]);
  });
});

describe("displayRefs", () => {
  it("hides a remote copy of a local branch on the same commit", () => {
    expect(displayRefs([branch("oak"), remote("origin/oak")], null).tags).toEqual([branch("oak")]);
    expect(displayRefs([remote("origin/oak")], null).tags).toEqual([remote("origin/oak")]);
  });

  it("keeps the base even when a local branch of that name is here", () => {
    const refs = [branch("main"), remote("origin/main")];
    expect(displayRefs(refs, "origin/main").tags).toEqual(refs);
  });

  it("shows two refs and counts the rest with their names", () => {
    const { tags, overflow } = displayRefs([branch("a"), tag("v1"), tag("v2"), tag("v3")], null);
    expect(tags.map((r) => r.name)).toEqual(["a", "v1"]);
    expect(overflow).toEqual(["v2", "v3"]);
    expect(displayRefs([branch("a")], null).overflow).toEqual([]);
  });

  it("counts after the hidden copies are dropped", () => {
    const { tags, overflow } = displayRefs([branch("a"), remote("origin/a"), tag("v1")], null);
    expect(tags.map((r) => r.name)).toEqual(["a", "v1"]);
    expect(overflow).toEqual([]);
  });
});

describe("rememberOpen", () => {
  it("is capped and drops the oldest entry first", () => {
    let open = new Map<string, boolean>();
    for (let i = 0; i < OPEN_CAP + 3; i++) open = rememberOpen(open, `w${i}`, true);
    expect(open.size).toBe(OPEN_CAP);
    expect(open.has("w0")).toBe(false);
    expect(open.has("w2")).toBe(false);
    expect(open.has("w3")).toBe(true);
    expect(open.has(`w${OPEN_CAP + 2}`)).toBe(true);
  });

  it("makes a set-again entry the newest and leaves the input alone", () => {
    const first = rememberOpen(new Map(), "a", true);
    const second = rememberOpen(rememberOpen(first, "b", true), "a", false);
    expect([...second]).toEqual([["b", true], ["a", false]]);
    expect([...first]).toEqual([["a", true]]);
  });
});

describe("clampHistoryHeight", () => {
  it("stays within 96 and 520", () => {
    expect(clampHistoryHeight(10, 3000)).toBe(96);
    expect(clampHistoryHeight(9000, 3000)).toBe(520);
    expect(clampHistoryHeight(256, 3000)).toBe(256);
  });

  it("is at most a third of the window", () => {
    expect(clampHistoryHeight(400, 900)).toBe(297);
    expect(clampHistoryHeight(200, 900)).toBe(200);
  });

  it("never goes under the minimum, even in a tiny window", () => {
    expect(clampHistoryHeight(256, 100)).toBe(96);
  });
});
