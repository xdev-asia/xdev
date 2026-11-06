import type { Api, NotchState, NotchTab } from "./api";

type NotchApi = Pick<Api, "notchReport" | "notchState" | "notchOpen" | "onNotchState">;

export type MockNotch = NotchApi & {
  // The tabs of the last `notchReport` call; for tests.
  __notchTabs(): NotchTab[];
};

/** The strip's state in memory; the mock has no notch, so the gap stays 0 and the pick is the Rust one. */
export function createMockNotch(clickTab: (ptyId: string) => void): MockNotch {
  let tabs: NotchTab[] = [];
  let state: NotchState = { view: { kind: "hidden" }, gap: 0 };
  const listeners = new Set<(s: NotchState) => void>();
  return {
    async notchReport(next) {
      tabs = structuredClone(next);
      const first = (status: NotchTab["status"]) => next.filter((t) => t.status === status);
      const waiting = first("needs-you");
      const failed = first("failed");
      const working = first("working");
      const [top, rest] = waiting.length ? [waiting, "needs-you" as const] : [failed, "failed" as const];
      const view: NotchState["view"] = top[0]
        ? { kind: rest, ptyId: top[0].ptyId, name: top[0].name, worktree: top[0].worktree, others: top.length - 1 }
        : working[0] ? { kind: "working", ptyId: working[0].ptyId, count: working.length } : { kind: "hidden" };
      if (JSON.stringify(view) === JSON.stringify(state.view)) return;
      state = { ...state, view };
      for (const cb of listeners) cb(structuredClone(state));
    },
    async notchState() {
      return structuredClone(state);
    },
    async notchOpen(ptyId) {
      if (ptyId) clickTab(ptyId);
    },
    async onNotchState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    __notchTabs: () => structuredClone(tabs),
  };
}
