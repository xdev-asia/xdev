import { toApiError, type Api, type ReviewAiPlan, type ReviewNote } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { findingNote } from "./aiFindings";

export type AiPhase = "idle" | "planning" | "running" | "done" | "cancelled" | "error";

export type AiSnapshot = {
  phase: AiPhase;
  /** Hunks answered so far, and how many the run sends. */
  done: number;
  total: number;
  /** The findings, as notes the diff draws; replaced by the next run. */
  notes: ReviewNote[];
  skipped: ReviewAiPlan["skipped"];
  error: Problem | null;
};

/** Which diffs have been reviewed automatically. */
export interface SeenDiffs {
  has(key: string): boolean;
  add(key: string): void;
}

const SEEN_KEY = "xdev.review.ai.seen";
const SEEN_MAX = 50;

/** The seen diffs kept in `storage`, the newest 50. */
export function storedSeen(storage: Pick<Storage, "getItem" | "setItem"> | null): SeenDiffs {
  const read = (): string[] => {
    try {
      const raw: unknown = JSON.parse(storage?.getItem(SEEN_KEY) ?? "[]");
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    has: (key) => read().includes(key),
    add: (key) => {
      try {
        storage?.setItem(SEEN_KEY, JSON.stringify([...read().filter((k) => k !== key), key].slice(-SEEN_MAX)));
      } catch {
        // A full or blocked storage only means the diff may be reviewed again.
      }
    },
  };
}

export const AUTO_KEY = "xdev.review.ai.auto";

export const readAuto = (storage: Pick<Storage, "getItem"> | null): boolean => storage?.getItem(AUTO_KEY) === "1";
export const writeAuto = (storage: Pick<Storage, "setItem"> | null, on: boolean): void => {
  try {
    storage?.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    // Not kept; the checkbox still works for this session.
  }
};

const IDLE: AiSnapshot = { phase: "idle", done: 0, total: 0, notes: [], skipped: [], error: null };

/**
 * The AI review of one worktree: plans the hunks, asks about them one after another, and keeps the
 * findings as notes. A first error stops the run and is kept for one inline message. Subscribe with
 * useSyncExternalStore.
 */
export class AiReview {
  private state: AiSnapshot = IDLE;
  private listeners = new Set<() => void>();
  private gen = 0;
  private seq = 0;

  constructor(
    private readonly api: Api,
    private readonly worktree: string,
    private readonly seen: SeenDiffs,
    private readonly clock: () => number = Date.now,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = (): AiSnapshot => this.state;

  private set(patch: Partial<AiSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  get busy(): boolean {
    return this.state.phase === "planning" || this.state.phase === "running";
  }

  /**
   * Reviews the changes against `base`. With `auto` a diff already reviewed (same hash) is left alone;
   * a diff is marked as seen when its run starts, so a stopped run is not started again by itself.
   */
  async run(base: string, opts: { auto?: boolean } = {}): Promise<void> {
    if (this.busy) return;
    const gen = ++this.gen;
    this.set({ ...IDLE, phase: "planning" });
    let plan: ReviewAiPlan;
    try {
      plan = await this.api.worktreeReviewAiPlan(this.worktree, base);
    } catch (e) {
      if (gen === this.gen) this.set({ phase: "error", error: toApiError(e) });
      return;
    }
    if (gen !== this.gen) return;
    const key = `${this.worktree}|${plan.diffHash}`;
    if (opts.auto && this.seen.has(key)) {
      this.set(IDLE);
      return;
    }
    this.seen.add(key);
    if (plan.hunks.length === 0) {
      this.set({ phase: "done", skipped: plan.skipped, total: 0 });
      return;
    }
    this.set({ phase: "running", total: plan.hunks.length, skipped: plan.skipped });
    const notes: ReviewNote[] = [];
    for (const hunk of plan.hunks) {
      try {
        const found = await this.api.worktreeReviewAiHunk(this.worktree, hunk);
        if (gen !== this.gen) return;
        for (const f of found) notes.push(findingNote(hunk.file, f, ++this.seq, this.clock()));
      } catch (e) {
        if (gen === this.gen) this.set({ phase: "error", error: toApiError(e), notes: [...notes] });
        return;
      }
      this.set({ done: this.state.done + 1, notes: [...notes] });
    }
    this.set({ phase: "done", notes });
  }

  /** Stops after the hunk being asked about; what was found so far stays. */
  cancel(): void {
    if (!this.busy) return;
    this.gen++;
    this.set({ phase: "cancelled" });
  }

  /** Takes the finding away; returns it, or `null` when it is not there. */
  dismiss(id: string): ReviewNote | null {
    const found = this.state.notes.find((n) => n.id === id) ?? null;
    if (found) this.set({ notes: this.state.notes.filter((n) => n.id !== id) });
    return found;
  }
}
