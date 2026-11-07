import type { LineAttribution } from "@/api";
import { applicable } from "./lineGutterModel";
import { MIN_GAP_MS } from "./useAttribution";
import { delayUntilNext } from "./versionsModel";

export type LineAuthorsFeedDeps<H> = {
  /** Reads the line authors of the file on disk. */
  fetch: () => Promise<LineAttribution>;
  now: () => number;
  schedule: (run: () => void, ms: number) => H;
  cancel: (handle: H) => void;
  /** The runs for `text`, or `null` when they do not fit it or the read failed. */
  onResult: (attr: LineAttribution | null, text: string) => void;
};

export type LineAuthorsFeed = {
  /** The text last read or written; a new one reads again. */
  request: (saved: string) => void;
  /** Something in the worktree moved; reads again. */
  changed: () => void;
  dispose: () => void;
};

/**
 * Line authors of the file in the editor, read again on save, reload and change events. Reads are
 * never closer than `MIN_GAP_MS`, at most one is pending, and a result for an older text is dropped.
 */
export function createLineAuthorsFeed<H>({ fetch, now, schedule, cancel, onResult }: LineAuthorsFeedDeps<H>): LineAuthorsFeed {
  let saved: string | undefined;
  let last = Number.NEGATIVE_INFINITY;
  let timer: { handle: H } | undefined;
  let seq = 0;
  let disposed = false;

  const read = (): void => {
    if (saved === undefined) return;
    last = now();
    const mine = ++seq;
    const text = saved;
    const fresh = () => !disposed && mine === seq && text === saved;
    let pending: Promise<LineAttribution>;
    try {
      pending = fetch();
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (attr) => {
        if (fresh()) onResult(applicable(attr, text) ? attr : null, text);
      },
      () => {
        if (fresh()) onResult(null, text);
      },
    );
  };

  const trigger = (): void => {
    if (disposed || saved === undefined || timer) return;
    const wait = delayUntilNext(last, now(), MIN_GAP_MS);
    if (wait === 0) return read();
    timer = {
      handle: schedule(() => {
        timer = undefined;
        read();
      }, wait),
    };
  };

  return {
    request(next) {
      if (next === saved) return;
      saved = next;
      trigger();
    },
    changed: trigger,
    dispose() {
      disposed = true;
      if (timer) cancel(timer.handle);
      timer = undefined;
    },
  };
}
