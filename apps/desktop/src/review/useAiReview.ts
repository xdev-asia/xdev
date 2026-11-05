import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Api } from "@/api";
import { AiReview, storedSeen, type AiSnapshot } from "./aiReview";

export type AiReviewState = AiSnapshot & { busy: boolean; run: AiReview["run"]; cancel: AiReview["cancel"]; dismiss: AiReview["dismiss"] };

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** The AI review of `worktree`; made again for another worktree or api, and stopped when the view goes. */
export function useAiReview(api: Api, worktree: string): AiReviewState {
  const held = useRef<{ api: Api; worktree: string; review: AiReview } | null>(null);
  if (!held.current || held.current.api !== api || held.current.worktree !== worktree) {
    held.current = { api, worktree, review: new AiReview(api, worktree, storedSeen(storage())) };
  }
  const { review } = held.current;
  useEffect(() => () => review.cancel(), [review]);
  const snap = useSyncExternalStore(review.subscribe, review.snapshot, review.snapshot);
  return { ...snap, busy: review.busy, run: review.run.bind(review), cancel: review.cancel.bind(review), dismiss: review.dismiss.bind(review) };
}
