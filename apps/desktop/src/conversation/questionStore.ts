// The question each tab waits on, for the card in its conversation and the badge on its tab.
// A `needs-input` hook sets it; any later hook of that pane but `attention` clears it, as does an
// answer sent from the card. The conversation view adds a question it read from the transcript.
import { useSyncExternalStore } from "react";
import type { Api, HookDetail } from "@/api";

export interface PendingQuestion {
  source: "hook" | "transcript";
  /** The hook's detail; null for a hook without one, or a transcript question. */
  detail: HookDetail | null;
  /** The transcript text the question came from. */
  text: string | null;
  /** A number that changes with each new question of the tab. */
  seq: number;
}

let byTab = new Map<string, PendingQuestion>();
let seq = 0;
const listeners = new Set<() => void>();
const fed = new WeakSet<object>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

function set(tab: string, q: PendingQuestion | null): void {
  if (q === null ? !byTab.has(tab) : byTab.get(tab) === q) return;
  const next = new Map(byTab);
  if (q === null) next.delete(tab);
  else next.set(tab, q);
  byTab = next;
  emit();
}

/** Starts reading hook events of `api` into the store; once per api object, so pass the same one each time. */
export function feedQuestions(api: Pick<Api, "onPtyHook">): void {
  if (fed.has(api)) return;
  fed.add(api);
  void api
    .onPtyHook((h) => {
      if (h.event === "needs-input") set(h.id, { source: "hook", detail: h.detail ?? null, text: null, seq: ++seq });
      else if (h.event !== "attention") set(h.id, null);
    })
    .catch(() => fed.delete(api));
}

/** Notes (or with null, drops) the transcript question of `tab`. A hook question is left alone. */
export function noteTranscriptQuestion(tab: string, text: string | null): void {
  const now = byTab.get(tab);
  if (now?.source === "hook") return;
  if (text === null) {
    if (now) set(tab, null);
    return;
  }
  if (now?.text === text) return;
  set(tab, { source: "transcript", detail: null, text, seq: ++seq });
}

/** Forgets the question of `tab` (it was answered). */
export function clearQuestion(tab: string): void {
  set(tab, null);
}

export function questionOf(tab: string): PendingQuestion | null {
  return byTab.get(tab) ?? null;
}

/** Calls `fn` on every change of any tab's question. */
export function subscribeQuestions(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useQuestion(tab: string): PendingQuestion | null {
  return useSyncExternalStore(
    subscribeQuestions,
    () => byTab.get(tab) ?? null,
    () => null,
  );
}

/** The questions of every tab; a new object after each change, so it serves as a snapshot. */
export function questionsSnapshot(): ReadonlyMap<string, PendingQuestion> {
  return byTab;
}

/**
 * Whether a stored question still holds for a tab in `status`: a hook question while the tab needs the
 * person, a transcript question while it rests at its prompt.
 */
export function questionLive(q: Pick<PendingQuestion, "source">, status: string): boolean {
  return q.source === "hook" ? status === "needs-you" : status === "done" || status === "idle";
}

/** For tests: an empty store. */
export function resetQuestions(): void {
  byTab = new Map();
  emit();
}
