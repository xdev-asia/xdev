import { useEffect, useState } from "react";
import type { Api, FsEvent } from "@/api";

let counter = 0;

/**
 * Subscribes to the disk events of `worktree` while it is the shown one, and returns the latest
 * batch (a new array each time). A subscription that cannot start leaves the app as it was: the
 * tree still refreshes on its own triggers.
 */
export function useWorktreeWatch(api: Api, worktree: string | null): FsEvent[] | null {
  const [events, setEvents] = useState<FsEvent[] | null>(null);
  useEffect(() => {
    setEvents(null);
    if (worktree === null) return;
    const id = `watch-${++counter}`;
    let live = true;
    const started = api
      .filesWatch(worktree, id, (batch) => {
        if (live && batch.worktree === worktree) setEvents(batch.events);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      // After the start settles, so an unwatch never overtakes its own watch.
      void started.then(() => api.filesUnwatch(id)).catch(() => undefined);
    };
  }, [api, worktree]);
  return events;
}
