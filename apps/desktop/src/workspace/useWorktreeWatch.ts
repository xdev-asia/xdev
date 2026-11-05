import { useEffect, useRef, useState } from "react";
import type { Api, FsEvent } from "@/api";
import type { FileIo } from "@/files/fileIO";
import { WorktreeWatch, type WatchHealth } from "./worktreeWatch";

export interface WatchView {
  /** The latest batch (a new array each time), for the file tree. */
  events: FsEvent[] | null;
  health: WatchHealth;
}

/** Subscribes to the disk events of `worktree` while it is the shown one (see `WorktreeWatch`). */
export function useWorktreeWatch(api: Api, worktree: string | null, io: FileIo): WatchView {
  const [events, setEvents] = useState<FsEvent[] | null>(null);
  const [health, setHealth] = useState<WatchHealth>("live");
  // The translator changes with the language; the subscription must not.
  const ioNow = useRef(io);
  ioNow.current = io;
  useEffect(() => {
    setEvents(null);
    setHealth("live");
    if (worktree === null) return;
    const watch = new WorktreeWatch({ api, worktree, io: () => ioNow.current, onBatch: setEvents, onHealth: setHealth });
    watch.start();
    // Back in the window: whatever changed meanwhile (a watcher that is down misses it) is read.
    const focus = () => watch.recheck();
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
      watch.stop();
    };
  }, [api, worktree]);
  return { events, health };
}
