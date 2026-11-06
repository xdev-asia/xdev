import { useSyncExternalStore } from "react";
import type { Api, LspDiagnostic, LspEvent, LspLanguage } from "@/api";
import { pushToast } from "@/workspace/toastStore";

const NONE: readonly LspDiagnostic[] = [];
const key = (worktree: string, rel: string) => `${worktree}\0${rel}`;

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The diagnostics the servers pushed, per file, with the people listening. */
export class DiagnosticsStore {
  private readonly map = new Map<string, readonly LspDiagnostic[]>();
  private readonly listeners = new Set<(worktree: string, rel: string) => void>();

  get(worktree: string, rel: string): readonly LspDiagnostic[] {
    return this.map.get(key(worktree, rel)) ?? NONE;
  }

  set(worktree: string, rel: string, items: readonly LspDiagnostic[]): void {
    if (items.length === 0) this.map.delete(key(worktree, rel));
    else this.map.set(key(worktree, rel), items);
    for (const fn of [...this.listeners]) fn(worktree, rel);
  }

  /** Drops what is known of one file (it closed). */
  clear(worktree: string, rel: string): void {
    if (this.map.delete(key(worktree, rel))) for (const fn of [...this.listeners]) fn(worktree, rel);
  }

  /** `fn` runs for every file whose diagnostics changed. */
  subscribe = (fn: (worktree: string, rel: string) => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
}

/** The one store the editors read. */
export const diagnostics = new DiagnosticsStore();

export function useDiagnostics(worktree: string, rel: string, store: DiagnosticsStore = diagnostics): readonly LspDiagnostic[] {
  return useSyncExternalStore(
    (fn) => store.subscribe((w, r) => w === worktree && r === rel && fn()),
    () => store.get(worktree, rel),
    () => store.get(worktree, rel),
  );
}

const LANGUAGE_NAME: Record<LspLanguage, string> = { typescript: "TypeScript", rust: "Rust", python: "Python", go: "Go", csharp: "C#" };

/**
 * Listens to the servers once: diagnostics go into `store`; a server that crashed (it stays down
 * after the host's own restarts) is a toast that offers Restart. Returns the way to stop.
 */
export function subscribeDiagnostics(
  api: Pick<Api, "lspSubscribe">,
  deps: { store?: DiagnosticsStore; t: () => T; restart(worktree: string): void },
): () => void {
  const store = deps.store ?? diagnostics;
  let stop: (() => void) | null = null;
  let stopped = false;
  const onEvent = (e: LspEvent): void => {
    if (e.kind === "diagnostics") return store.set(e.worktree, e.rel, e.items);
    if (e.state !== "crashed") return;
    const t = deps.t();
    pushToast({
      id: `lsp-crashed:${e.worktree}:${e.language}`,
      text: t("lsp.crashed", { language: LANGUAGE_NAME[e.language] ?? e.language }),
      actions: [{ label: t("lsp.restart"), run: () => deps.restart(e.worktree) }],
    });
  };
  void api.lspSubscribe(onEvent).then(
    (off) => {
      if (stopped) off();
      else stop = off;
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    stop?.();
  };
}
