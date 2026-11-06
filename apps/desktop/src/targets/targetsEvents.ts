import type { SimDevice } from "@/api";

/** What the palette and the menu ask of the tab strip: open the Run targets menu, open the server shell, or start a simulator. */
export type TargetsRequest = { kind: "menu" } | { kind: "serverShell" } | { kind: "sim"; device: SimDevice };

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
