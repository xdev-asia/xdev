// A follow-up about a sub-agent's result, put in a tab's composer draft. No CLI here can send a message to a
// sub-agent that ended, so the follow-up goes to the main agent, naming the run. The composer host listens
// and opens on the tab, where the stored draft is read.
import type { Api } from "@/api";

const listeners = new Set<(tab: string) => void>();

/** Calls `fn` with the tab whose composer should open; returns the unsubscribe. */
export function onComposerRequest(fn: (tab: string) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Stores `text` as the composer draft of `tab` and asks the composer to open; false when it could not be stored. */
export async function sendFollowUp(api: Pick<Api, "composerDraftPut">, tab: string, text: string): Promise<boolean> {
  try {
    await api.composerDraftPut(tab, text);
  } catch {
    return false;
  }
  for (const fn of [...listeners]) fn(tab);
  return true;
}
