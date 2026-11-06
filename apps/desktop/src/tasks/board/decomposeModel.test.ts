import { describe, expect, it } from "vitest";
import type { TaskDraft } from "@/api";
import { canAsk, decomposeReducer, finalDrafts, initialDecompose, type DecomposeAction, type DecomposeState } from "./decomposeModel";

const draft = (title: string): TaskDraft => ({ title, status: "todo", priority: "p2", labels: [], body: "" });
const run = (actions: DecomposeAction[], from: DecomposeState = initialDecompose): DecomposeState => actions.reduce(decomposeReducer, from);
const asked: DecomposeAction[] = [{ type: "goal", goal: "Build X" }, { type: "ask", run: 1 }];

describe("decomposeModel", () => {
  it("an empty goal cannot be asked", () => {
    expect(canAsk(initialDecompose)).toBe(false);
    expect(run([{ type: "goal", goal: "  " }, { type: "ask", run: 1 }]).step).toBe("goal");
  });

  it("goal, running and review follow each other; back returns to the goal", () => {
    let s = run(asked);
    expect(s.step).toBe("running");
    s = run([{ type: "answered", run: 1, drafts: [draft("a"), draft("b")] }], s);
    expect(s.step).toBe("review");
    expect(s.rows.map((r) => r.checked)).toEqual([true, true]);
    s = run([{ type: "back" }], s);
    expect(s.step).toBe("goal");
    expect(s.goal).toBe("Build X");
  });

  it("a failure returns to the goal with the code", () => {
    const s = run([...asked, { type: "failed", run: 1, code: "board_decompose_bad" }]);
    expect(s.step).toBe("goal");
    expect(s.error).toBe("board_decompose_bad");
  });

  it("unchecking every row leaves nothing to write", () => {
    const s = run([...asked, { type: "answered", run: 1, drafts: [draft("a"), draft("b")] }, { type: "check", key: 0, checked: false }, { type: "check", key: 1, checked: false }]);
    expect(finalDrafts(s.rows)).toEqual([]);
  });

  it("an edited title and priority are kept; only checked rows are built", () => {
    const s = run([
      ...asked,
      { type: "answered", run: 1, drafts: [draft("a"), draft("b")] },
      { type: "edit", key: 1, patch: { title: "  Better b ", priority: "p0" } },
      { type: "check", key: 0, checked: false },
    ]);
    const out = finalDrafts(s.rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Better b", priority: "p0", status: "todo" });
  });

  it("a checked row with a blank title is not written", () => {
    const s = run([...asked, { type: "answered", run: 1, drafts: [draft("a")] }, { type: "edit", key: 0, patch: { title: " " } }]);
    expect(finalDrafts(s.rows)).toEqual([]);
  });

  it("cancel ignores a late result", () => {
    const s = run([...asked, { type: "cancel" }, { type: "answered", run: 1, drafts: [draft("a")] }]);
    expect(s.step).toBe("goal");
    expect(s.rows).toEqual([]);
    // A late failure is ignored too.
    expect(run([{ type: "failed", run: 1, code: "io" }], s).error).toBeNull();
  });

  it("an answer of an older run does not replace a newer run", () => {
    const s = run([...asked, { type: "cancel" }, { type: "ask", run: 2 }, { type: "answered", run: 1, drafts: [draft("old")] }]);
    expect(s.step).toBe("running");
  });
});
