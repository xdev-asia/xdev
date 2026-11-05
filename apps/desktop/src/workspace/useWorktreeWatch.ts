import { useEffect, useRef, useState } from "react";
import type { Api } from "@/api";
import type { FileIo } from "@/files/fileIO";
import { emptyQueue, enqueue, type WatchQueue } from "@/files/treeRefresh";
import { WorktreeWatch, type WatchHealth } from "./worktreeWatch";

export interface WatchView {
  /** Every batch not yet dropped (a new queue each time), for the file tree to drain. */
  queue: WatchQueue;
  health: WatchHealth;
}

/** Subscribes to the disk events of `worktree` while it is the shown one (see `WorktreeWatch`). */
export function useWorktreeWatch(api: Api, worktree: string | null, io: FileIo): WatchView {
  const [queue, setQueue] = useState<WatchQueue>(() => emptyQueue(worktree));
  const [health, setHealth] = useState<WatchHealth>("live");
  // The translator changes with the language; the subscription must not.
  const ioNow = useRef(io);
  ioNow.current = io;
  useEffect(() => {
    setQueue(emptyQueue(worktree));
    setHealth("live");
    if (worktree === null) return;
    const watch = new WorktreeWatch({ api, worktree, io: () => ioNow.current, onBatch: (events) => setQueue((q) => enqueue(q, events)), onHealth: setHealth });
    watch.start();
    // Back in the window: whatever changed meanwhile (a watcher that is down misses it) is read.
    const focus = () => watch.recheck();
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
      watch.stop();
    };
  }, [api, worktree]);
  return { queue, health };
}
