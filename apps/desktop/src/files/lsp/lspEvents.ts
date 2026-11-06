import type { LspPos } from "@/api";
import type { PaletteItem } from "@/palette/items";

/** What the editor extensions ask the host to show. */
export type LspAsk =
  | { kind: "rename"; worktree: string; rel: string; pos: LspPos; name: string }
  | { kind: "definitions"; worktree: string; at: { x: number; y: number }; targets: { rel: string; line: number; column: number }[] }
  | { kind: "symbols"; worktree: string }
  | { kind: "restart"; worktree: string };

const listeners = new Set<(ask: LspAsk) => void>();

/** Tells the host; returns whether one listened. */
export function askLsp(ask: LspAsk): boolean {
  for (const fn of [...listeners]) fn(ask);
  return listeners.size > 0;
}

/** The host listens here. Returns the unsubscribe. */
export function onLspAsk(fn: (ask: LspAsk) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function openSymbolSearch(worktree: string): boolean {
  return askLsp({ kind: "symbols", worktree });
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The palette's way in; nothing without a current worktree. */
export function lspItems(t: T, worktree: string | null): PaletteItem[] {
  if (!worktree) return [];
  return [
    {
      id: "lsp:symbols",
      kind: "action",
      title: t("lsp.palette.symbols"),
      keywords: t("lsp.palette.symbols.keywords").split(/\s+/).filter(Boolean),
      run: () => void openSymbolSearch(worktree),
    },
    {
      id: "lsp:restart",
      kind: "action",
      title: t("lsp.palette.restart"),
      keywords: t("lsp.palette.restart.keywords").split(/\s+/).filter(Boolean),
      run: () => void askLsp({ kind: "restart", worktree }),
    },
  ];
}
