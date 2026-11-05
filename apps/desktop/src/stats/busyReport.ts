import type { Api } from "@/api";
import type { Sessions } from "@/workspace/sessions";

/**
 * Tells the app each time an agent tab enters or leaves the `working` status; the app keeps the clock.
 * Stopping sends `false` for every tab still working, so a closed window leaves no span open.
 */
export function startBusyReport(api: Pick<Api, "appStatsBusy">, sessions: Pick<Sessions, "onStatus">): () => void {
  const live = new Set<string>();
  const send = (id: string, working: boolean) => {
    try {
      void Promise.resolve(api.appStatsBusy(id, working)).catch(() => {});
    } catch {
      // Best effort: a lost edge costs one span, never the app.
    }
  };
  const off = sessions.onStatus((tab, from, to) => {
    if (!tab.agent) return;
    if (to === "working" && from !== "working") {
      live.add(tab.id);
      send(tab.id, true);
    } else if (from === "working" && to !== "working") {
      live.delete(tab.id);
      send(tab.id, false);
    }
  });
  return () => {
    off();
    for (const id of live) send(id, false);
    live.clear();
  };
}
