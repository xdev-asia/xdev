import { useEffect, useState } from "react";
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
  // The feed and the newest text, kept across draws (state, not a ref: the file view's tests stand in hooks).
  const [box] = useState<{ feed: LineAuthorsFeed | null; saved: string | undefined }>({ feed: null, saved: undefined });
  box.saved = saved;

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
    box.feed = f;
    if (box.saved !== undefined) f.request(box.saved);
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
      if (box.feed === f) box.feed = null;
    };
  }, [api, worktree, rel, on, box]);

  useEffect(() => {
    if (saved !== undefined) box.feed?.request(saved);
  }, [saved, box]);

  return on ? result : null;
}
