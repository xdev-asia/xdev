import { useSyncExternalStore } from "react";

const key = (worktree: string, rel: string) => `${worktree}\0${rel}`;

/** What the host said about a document: it has a server, none (off, not found) or the person has to allow it. */
export type DocStatus = "ready" | "off" | "untrusted";

/** Small stores the editors read: per-document status and the worktrees that wait for a trust answer. */
export class LspStatusStore {
  private docs = new Map<string, DocStatus>();
  private ask = new Set<string>();
  private hidden = new Set<string>();
  private version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  snapshot = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  doc(worktree: string, rel: string): DocStatus | null {
    return this.docs.get(key(worktree, rel)) ?? null;
  }

  setDoc(worktree: string, rel: string, status: DocStatus | null): void {
    if (this.doc(worktree, rel) === status) return;
    if (status === null) this.docs.delete(key(worktree, rel));
    else this.docs.set(key(worktree, rel), status);
    this.emit();
  }

  /** True while the panel "Start language servers for this repo?" should show. */
  asking(worktree: string): boolean {
    return this.ask.has(worktree) && !this.hidden.has(worktree);
  }

  setAsking(worktree: string, on: boolean): void {
    if (this.ask.has(worktree) === on) return;
    if (on) this.ask.add(worktree);
    else this.ask.delete(worktree);
    this.emit();
  }

  /** "Not now": the panel stays away for this worktree until the app starts again. */
  hide(worktree: string): void {
    if (this.hidden.has(worktree)) return;
    this.hidden.add(worktree);
    this.emit();
  }
}

export const lspStatus = new LspStatusStore();

export function useAsking(worktree: string, store: LspStatusStore = lspStatus): boolean {
  return useSyncExternalStore(store.subscribe, () => store.asking(worktree), () => store.asking(worktree));
}
