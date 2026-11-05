import { useEffect, useState } from "react";
import type { Api, ContextUsage } from "@/api";
import type { TabStatus } from "@/workspace/status";

/** While the agent works, its log grows: read again this often. */
export const CONTEXT_POLL_MS = 30_000;

/**
 * The context usage of an agent session, read when the session or the tab's settled state changes and
 * every 30 seconds while the agent works. `null` when unknown or unreadable: the chip is then hidden.
 */
export function useContextUsage(api: Pick<Api, "agentContextUsage">, session: string | null, status: TabStatus, on: boolean): ContextUsage | null {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const working = status === "working";
  useEffect(() => {
    if (!on || !session) {
      setUsage(null);
      return;
    }
    let live = true;
    const load = () => {
      api.agentContextUsage(session).then(
        (found) => live && setUsage(found),
        () => live && setUsage(null),
      );
    };
    load();
    const id = working ? setInterval(load, CONTEXT_POLL_MS) : undefined;
    return () => {
      live = false;
      clearInterval(id);
    };
    // `status` re-reads when a turn ends: its tokens are in the log by then.
  }, [api, session, on, working, status]);
  return usage;
}
