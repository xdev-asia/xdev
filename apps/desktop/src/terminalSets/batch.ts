/** The pause between two spawns of one batch, in ms. */
export const STAGGER_MS = 300;
/** The fewest and most copies one launch opens. */
export const COPIES_MIN = 1;
export const COPIES_MAX = 8;

/** A copies field as a whole number in range; anything else is 1. */
export function clampCopies(value: number | string): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return COPIES_MIN;
  return Math.min(COPIES_MAX, Math.max(COPIES_MIN, Math.trunc(n)));
}

export interface BatchProgress {
  /** Spawns tried so far (ok or failed). */
  tried: number;
  total: number;
  /** Indexes of the spawns that failed, in order. */
  failed: number[];
}

export interface BatchOptions {
  staggerMs?: number;
  sleep?(ms: number): Promise<void>;
  onProgress?(p: BatchProgress): void;
}

/**
 * Runs `spawn(i)` for each index in order, `staggerMs` apart (none before the first). A spawn that
 * throws or rejects is recorded and the batch goes on. Resolves the final progress; `failed` holds the
 * indexes to hand back for a retry.
 */
export async function runBatch(indexes: readonly number[], spawn: (index: number) => unknown, opts: BatchOptions = {}): Promise<BatchProgress> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = opts.staggerMs ?? STAGGER_MS;
  const progress: BatchProgress = { tried: 0, total: indexes.length, failed: [] };
  opts.onProgress?.({ ...progress, failed: [] });
  for (let k = 0; k < indexes.length; k++) {
    if (k > 0) await sleep(gap);
    try {
      await spawn(indexes[k]);
    } catch {
      progress.failed.push(indexes[k]);
    }
    progress.tried++;
    opts.onProgress?.({ ...progress, failed: [...progress.failed] });
  }
  return progress;
}
