import { useEffect, useRef, useState } from "react";
import type { Api, FsEvent } from "@/api";
import type { FileIo } from "@/files/fileIO";
import { reconcile, resetWatchState } from "@/files/fileWatch";

let counter = 0;

/**
 * Subscribes to the disk events of `worktree` while it is the shown one. Each batch goes to the open
 * buffers (`reconcile`), and the latest is returned (a new array each time) for the file tree. A subscription that cannot start leaves the app as it was: the
 * tree still refreshes on its own triggers.
 */
export function useWorktreeWatch(api: Api, worktree: string | null, io: FileIo): FsEvent[] | null {
  const [events, setEvents] = useState<FsEvent[] | null>(null);
  // The translator changes with the language; the subscription must not.
  const ioNow = useRef(io);
  ioNow.current = io;
  useEffect(() => {
    setEvents(null);
    if (worktree === null) return;
    const id = `watch-${++counter}`;
    let live = true;
    const started = api
      .filesWatch(worktree, id, (batch) => {
        if (!live || batch.worktree !== worktree) return;
        reconcile(ioNow.current, worktree, batch.events);
        setEvents(batch.events);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      resetWatchState(worktree);
      // After the start settles, so an unwatch never overtakes its own watch.
      void started.then(() => api.filesUnwatch(id)).catch(() => undefined);
    };
  }, [api, worktree]);
  return events;
}
