import { afterEach, describe, expect, it } from "vitest";
import { createMockApi } from "@/mockApi";
import { leaves } from "./paneTree";
import { Sessions } from "./sessions";

const A = "/demo/wt/xdev-oak";
const B = "/demo/wt/xdev-elm";

describe("Sessions.snapshot", () => {
  let sessions: Sessions | null = null;
  const make = () => (sessions = new Sessions(createMockApi({}), () => 1000));
  afterEach(() => {
    sessions?.dispose();
    sessions = null;
  });

  it("keeps each terminal's pty id and the bytes it drew, for an attach after a restart", async () => {
    const s = make();
    const tab = s.open(A, "shell");
    let drawn = 0;
    await tab.client.start(A, "shell", 80, 24, (b, rendered) => {
      drawn += b.length;
      rendered();
    });
    const t1 = s.snapshot().worktrees[A].tabs.t1;
    expect(t1).toMatchObject({ kind: "terminal", ptyId: tab.id, seq: drawn });
    expect(drawn).toBeGreaterThan(0);
  });

  it("is empty without tabs", () => {
    expect(make().snapshot()).toEqual({ version: 1, savedAt: 1000, worktrees: {} });
  });

  it("holds both worktrees, a split with its sizes, and each tab's own fields", () => {
    const s = make();
    const claude = s.resume(A, "claude", "work", "sess-1", "Fix it");
    const shell = s.open(A, "shell");
    s.rename(shell.id, "build");
    s.setPinned(shell.id, true);
    s.setColor(shell.id, "c3");
    s.moveToSplit(shell.id, "right");
    const layout = s.layout(A)!;
    const split = layout.root;
    if (split.kind !== "split") throw new Error("expected a split");
    s.setLayout(A, { ...layout, root: { ...split, sizes: [0.3, 0.7] } });
    s.open(B, "shell");

    const snap = s.snapshot();
    expect(Object.keys(snap.worktrees)).toEqual([A, B]);
    const a = snap.worktrees[A];
    const root = a.layout.root;
    expect(root.kind === "split" && root.sizes).toEqual([0.3, 0.7]);
    expect(leaves(a.layout).map((n) => (n.kind === "leaf" ? n.tabs : []))).toEqual([["t1"], ["t2"]]);
    expect(a.layout.focused).toBe("p2");
    expect(a.tabs.t1).toMatchObject({ kind: "terminal", profileId: "claude", account: "work", agent: true, agentSession: "sess-1", title: "Fix it", pinned: false, color: "none" });
    expect(a.tabs.t2).toMatchObject({ kind: "terminal", profileId: "shell", title: "build", renamed: true, pinned: true, color: "c3", agent: false, agentSession: null });
    expect(claude.id).not.toBe("t1");
  });

  it("is the same for the same state", () => {
    const s = make();
    s.open(A, "claude");
    s.open(A, "shell");
    expect(s.snapshot()).toEqual(s.snapshot());
  });

  it("drops an exited tab and collapses its pane; review and file tabs keep their ids", () => {
    const api = createMockApi({});
    let exit: (e: { id: string; code: number | null }) => void = () => {};
    const real = api.onPtyExit.bind(api);
    api.onPtyExit = (cb) => {
      exit = cb;
      return real(cb);
    };
    const s = (sessions = new Sessions(api, () => 1000));
    s.open(A, "shell");
    const b = s.open(A, "shell");
    s.moveToSplit(b.id, "down");
    s.setLayout(A, { ...s.layout(A)!, root: s.layout(A)!.root });
    const withFile = s.layout(A)!;
    // A file tab and the review tab live in the pane tree under their own ids.
    const leaf = leaves(withFile)[0];
    if (leaf.kind !== "leaf") throw new Error("leaf");
    s.setLayout(A, { ...withFile, root: JSON.parse(JSON.stringify(withFile.root).replace(`"tabs":["${leaf.tabs[0]}"]`, `"tabs":["${leaf.tabs[0]}","file:src/a.ts","review:"]`)) });
    exit({ id: b.id, code: 0 });

    const one = s.snapshot().worktrees[A];
    expect(one.layout.root.kind).toBe("leaf");
    expect(Object.keys(one.tabs).sort()).toEqual(["file:src/a.ts", "review:", "t1"]);
    expect(one.tabs["file:src/a.ts"]).toEqual({ kind: "file", rel: "src/a.ts" });
    expect(one.tabs["review:"]).toEqual({ kind: "review" });
  });

  it("does not keep the commit tab", () => {
    const s = make();
    const a = s.open(A, "shell");
    const l = s.layout(A)!;
    s.setLayout(A, { ...l, root: JSON.parse(JSON.stringify(l.root).replace(`"tabs":["${a.id}"]`, `"tabs":["${a.id}","commit:"]`)) });
    const one = s.snapshot().worktrees[A];
    expect(Object.keys(one.tabs)).toEqual(["t1"]);
    expect(JSON.stringify(one.layout)).not.toContain("commit:");
  });

  it("leaves the setup script's tab out", () => {
    const s = make();
    s.open(A, "xdev:setup");
    expect(s.snapshot().worktrees).toEqual({});
  });
});
