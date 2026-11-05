import { describe, expect, it } from "vitest";
import type { MissionTab } from "@/api";
import { missionOrder, stuckReason } from "./stuck";

const MIN = 60_000;
const NOW = 1_000 * MIN;

function tab(over: Partial<MissionTab>): MissionTab {
  return { id: "t", title: null, worktree: "/w", profile: "claude", agent: true, status: "idle", lastOutputMs: NOW, exited: false, worker: null, lastNudgeMs: null, ...over };
}

describe("stuckReason", () => {
  it("a busy tab is stuck after N quiet minutes, not before", () => {
    expect(stuckReason(tab({ status: "working", lastOutputMs: NOW - 9 * MIN }), NOW, 10)).toBeNull();
    expect(stuckReason(tab({ status: "working", lastOutputMs: NOW - 10 * MIN }), NOW, 10)).toBe("silent");
    expect(stuckReason(tab({ status: "working", lastOutputMs: NOW - 3 * MIN }), NOW, 2)).toBe("silent");
  });

  it("defaults to ten minutes", () => {
    expect(stuckReason(tab({ status: "working", lastOutputMs: NOW - 10 * MIN }), NOW)).toBe("silent");
    expect(stuckReason(tab({ status: "working", lastOutputMs: NOW - 9 * MIN }), NOW)).toBeNull();
  });

  it("a tab waiting on input is stuck at once", () => {
    expect(stuckReason(tab({ status: "needs-you", lastOutputMs: NOW }), NOW, 10)).toBe("waiting");
  });

  it("an idle, done or exited tab is never stuck, nor a busy one that never printed", () => {
    expect(stuckReason(tab({ status: "idle", lastOutputMs: NOW - 99 * MIN }), NOW, 10)).toBeNull();
    expect(stuckReason(tab({ status: "done", lastOutputMs: NOW - 99 * MIN }), NOW, 10)).toBeNull();
    expect(stuckReason(tab({ status: "needs-you", exited: true }), NOW, 10)).toBeNull();
    expect(stuckReason(tab({ status: "working", lastOutputMs: 0 }), NOW, 10)).toBeNull();
  });

  it("a threshold below one minute counts as one", () => {
    expect(stuckReason(tab({ status: "working", lastOutputMs: NOW - MIN }), NOW, 0)).toBe("silent");
  });
});

describe("missionOrder", () => {
  it("puts stuck tabs first, then workers, then linked, and leaves out unlinked shells", () => {
    const worker = { tab: "w", dispatchId: "d", runId: "r", state: "ready" as const, taskId: "t1", taskTitle: null, updatedMs: 0 };
    const tabs = [
      tab({ id: "plain", title: "A plain" }),
      tab({ id: "linked", title: "B linked" }),
      tab({ id: "worker", title: "C worker", worker }),
      tab({ id: "stuck", title: "D stuck", status: "needs-you" }),
      tab({ id: "shell", title: "E shell", agent: false }),
      tab({ id: "lshell", title: "F linked shell", agent: false }),
    ];
    const order = missionOrder(tabs, new Set(["linked", "lshell"]), NOW, 10).map((t) => t.id);
    expect(order).toEqual(["stuck", "worker", "linked", "lshell", "plain"]);
  });
});
