import { useSyncExternalStore } from "react";
import type { PeerRole } from "@/api";

// A terminal of another computer opens as a tab. Its id is `peer:<peerId>:<termId>`; terminal ids never
// contain a colon, so the prefix cannot clash with them, `file:`, `view:`, `preview:`, `review:` or `commit:`.
// The tabs live in this store, not in the saved layout: a watch tab is a live link, so it is not restored.
export const PEER_TAB = "peer:";

export interface PeerTabEntry {
  id: string;
  peerId: string;
  peerName: string;
  termId: string;
  title: string;
  theirRole: PeerRole | null;
  /** The worktree whose strip holds the tab; null until a visible one claims it. */
  owner: string | null;
  /** Rises each time the tab is asked for, so the strip brings it to the front. */
  seq: number;
}

export function peerTabId(peerId: string, termId: string): string {
  return `${PEER_TAB}${peerId}:${termId}`;
}

export function isPeerTab(id: string): boolean {
  return id.startsWith(PEER_TAB);
}

let entries: readonly PeerTabEntry[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Opens the tab, or brings the open one to the front. */
export function openPeerTab(peer: { id: string; name: string; theirRole: PeerRole | null }, term: { id: string; title: string }): string {
  const id = peerTabId(peer.id, term.id);
  const seq = ++counter;
  const found = entries.find((e) => e.id === id);
  entries = found
    ? entries.map((e) => (e.id === id ? { ...e, theirRole: peer.theirRole, seq } : e))
    : [...entries, { id, peerId: peer.id, peerName: peer.name, termId: term.id, title: term.title, theirRole: peer.theirRole, owner: null, seq }];
  emit();
  return id;
}

export function closePeerTab(id: string): void {
  if (!entries.some((e) => e.id === id)) return;
  entries = entries.filter((e) => e.id !== id);
  emit();
}

/** A worktree that is on screen takes the tabs nobody holds. */
export function claimPeerTabs(worktree: string): void {
  if (!entries.some((e) => e.owner === null)) return;
  entries = entries.map((e) => (e.owner === null ? { ...e, owner: worktree } : e));
  emit();
}

export function peerTabEntries(): readonly PeerTabEntry[] {
  return entries;
}

export function usePeerTabs(): readonly PeerTabEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    peerTabEntries,
    peerTabEntries,
  );
}

/** For tests. */
export function resetPeerTabs(): void {
  entries = [];
  counter = 0;
  emit();
}
