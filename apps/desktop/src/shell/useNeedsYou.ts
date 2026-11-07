import { useCallback, useSyncExternalStore } from "react";
import { questionsSnapshot, subscribeQuestions } from "@/conversation/questionStore";
import { selectNeedsYou, type NeedsYou } from "@/workspace/needsYou";
import type { Sessions } from "@/workspace/sessions";

// A string, so an unchanged store reads as the same snapshot.
const signature = (sessions: Sessions | null): string =>
  sessions
    ? sessions
        .worktrees()
        .flatMap((w) => sessions.tabs(w))
        .filter((tab) => tab.agent && (tab.status === "needs-you" || tab.status === "failed"))
        .map((tab) => `${tab.id}:${tab.status}:${tab.statusAt ?? ""}:${tab.asleep ? "z" : ""}`)
        .join("|")
    : "";

/** The "needs you" selector, live: what waits on the person across every worktree of the window. */
export function useNeedsYou(sessions: Sessions | null): NeedsYou {
  const subscribe = useCallback((listener: () => void) => sessions?.subscribe(listener) ?? (() => {}), [sessions]);
  useSyncExternalStore(subscribe, () => signature(sessions), () => signature(sessions));
  const questions = useSyncExternalStore(subscribeQuestions, questionsSnapshot, questionsSnapshot);
  const tabs = sessions ? sessions.worktrees().flatMap((w) => sessions.tabs(w)) : [];
  return selectNeedsYou(tabs, (id) => questions.get(id) ?? null);
}
