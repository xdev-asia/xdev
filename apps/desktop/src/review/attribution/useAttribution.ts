import { useEffect, useRef, useState } from "react";
import type { Api, AttributionEvent, FileAttribution } from "@/api";
import { delayUntilNext } from "./versionsModel";

/** Reads are at least this far apart, however often the backend says something moved. */
export const MIN_GAP_MS = 2000;
const RECENT = 20;

export type AttributionState = { files: FileAttribution[]; recent: AttributionEvent[]; failed: boolean };

/**
 * Who touched what in `worktree`. It reads once, then again when the backend sends
 * `attribution://changed`, never twice within `MIN_GAP_MS`.
 */
export function useAttribution(api: Api, worktree: string): AttributionState {
  const [state, setState] = useState<AttributionState>({ files: [], recent: [], failed: false });
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = async () => {
      last.current = Date.now();
      try {
        const [files, recent] = await Promise.all([api.attributionFiles(worktree), api.attributionRecent(worktree, RECENT)]);
        if (live) setState({ files, recent, failed: false });
      } catch {
        if (live) setState((s) => ({ ...s, failed: true }));
      }
    };
    void read();
    let stop: (() => void) | undefined;
    void api
      .onAttributionChanged((e) => {
        if (!live || e.worktree !== worktree || timer.current !== undefined) return;
        const wait = delayUntilNext(last.current, Date.now(), MIN_GAP_MS);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          void read();
        }, wait);
      })
      .then((off) => (live ? (stop = off) : off()));
    return () => {
      live = false;
      stop?.();
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [api, worktree]);
  return state;
}
