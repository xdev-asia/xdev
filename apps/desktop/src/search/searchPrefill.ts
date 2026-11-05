// A one-slot mailbox so any part of the app can open Search filled in: `requestSearch` posts, the panel takes.

export interface SearchPrefill {
  query?: string;
  /** The "files to include" glob. */
  include?: string;
}

type Listener = () => void;

let pending: SearchPrefill | null = null;
const listeners = new Set<Listener>();

/** Asks the search panel to fill in `request` and take the keyboard. Kept until a panel takes it. */
export function requestSearch(request: SearchPrefill): void {
  pending = { ...request };
  for (const l of [...listeners]) l();
}

/** The waiting request, and forgets it. */
export function consumeSearchPrefill(): SearchPrefill | null {
  const out = pending;
  pending = null;
  return out;
}

/** `listener` runs on each new request. Returns the unsubscribe. */
export function subscribeSearchPrefill(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** For tests: back to an empty mailbox. */
export function resetSearchPrefill(): void {
  pending = null;
  listeners.clear();
}
