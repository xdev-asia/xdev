import type { Api, AppStatsView } from "./api";

type AppStatsApi = Pick<Api, "appStats" | "appStatsBusy">;

/** App stats in memory: zeros at the start, spans measured with the wall clock. */
export function createMockAppStats(seed: Partial<AppStatsView> = {}): AppStatsApi {
  let done: AppStatsView = { agentsStarted: 0, prsCreated: 0, agentBusyMs: 0, sinceMs: null, ...seed };
  const live = new Map<string, number>();
  return {
    async appStats() {
      const now = Date.now();
      let running = 0;
      for (const start of live.values()) running += now - start;
      return { ...done, agentBusyMs: done.agentBusyMs + running };
    },
    async appStatsBusy(tabId, working) {
      if (working) {
        if (!live.has(tabId)) live.set(tabId, Date.now());
        return;
      }
      const start = live.get(tabId);
      if (start === undefined) return;
      live.delete(tabId);
      done = { ...done, agentBusyMs: done.agentBusyMs + (Date.now() - start) };
    },
  };
}
