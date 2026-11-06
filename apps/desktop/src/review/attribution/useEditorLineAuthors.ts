import { useEffect, useRef, useState } from "react";
import type { Api, LineAttribution } from "@/api";
import { createLineAuthorsFeed, type LineAuthorsFeed } from "./lineAuthorsFeed";

export type EditorLineAuthors = { attr: LineAttribution; text: string };

/**
 * Line authors of `rel` against `HEAD`, for the editor: the runs and the text they are for. Reads
 * when `saved` (the text last read or written) changes and on `attribution://changed` for
 * `worktree`, through the throttled feed. `null` while off, before a read, or when it does not fit.
 */
export function useEditorLineAuthors(api: Api, worktree: string, rel: string, saved: string | undefined, on: boolean): EditorLineAuthors | null {
  const [result, setResult] = useState<EditorLineAuthors | null>(null);
  const feed = useRef<LineAuthorsFeed | null>(null);
  const latest = useRef(saved);
  latest.current = saved;

  useEffect(() => {
    setResult(null);
    if (!on) return;
    const f = createLineAuthorsFeed({
      // An api without the command (an older mock) rejects and shows nothing.
      fetch: () => (typeof api.attributionLinesHead === "function" ? api.attributionLinesHead(worktree, rel) : Promise.reject(new Error("unsupported"))),
      now: () => Date.now(),
      schedule: (run, ms) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle),
      onResult: (attr, text) => setResult(attr ? { attr, text } : null),
    });
    feed.current = f;
    if (latest.current !== undefined) f.request(latest.current);
    let live = true;
    let stop: (() => void) | undefined;
    if (typeof api.onAttributionChanged === "function") {
      void api
        .onAttributionChanged((e) => {
          if (e.worktree === worktree) f.changed();
        })
        .then((off) => (live ? (stop = off) : off()))
        .catch(() => undefined);
    }
    return () => {
      live = false;
      stop?.();
      f.dispose();
      if (feed.current === f) feed.current = null;
    };
  }, [api, worktree, rel, on]);

  useEffect(() => {
    if (saved !== undefined) feed.current?.request(saved);
  }, [saved]);

  return on ? result : null;
}
