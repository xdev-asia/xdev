/** What the palette asks of the tab strip: open the Run targets menu, or open the server shell. */
export type TargetsRequest = { kind: "menu" } | { kind: "serverShell" };

const listeners = new Set<(req: TargetsRequest) => void>();

/** Asks the host to act. Nothing happens when it is not mounted. */
export function requestTargets(req: TargetsRequest): void {
  for (const cb of [...listeners]) cb(req);
}

/** The host listens here. Returns the unsubscribe. */
export function onTargetsRequest(cb: (req: TargetsRequest) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
