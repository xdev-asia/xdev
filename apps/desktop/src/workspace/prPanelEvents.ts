import type { PaletteItem } from "@/palette/items";

const openers = new Set<() => void>();

/** Asks the shell to open the pull request panel of the current worktree. Nothing happens when it is not mounted. */
export function openPrPanel(): void {
  for (const cb of [...openers]) cb();
}

/** The shell listens here. Returns the unsubscribe. */
export function onPrPanelOpen(cb: () => void): () => void {
  openers.add(cb);
  return () => void openers.delete(cb);
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The palette's way in. */
export function prPanelItems(t: T): PaletteItem[] {
  return [
    {
      id: "pr-panel:open",
      kind: "action",
      title: t("prPanel.palette"),
      keywords: t("prPanel.palette.keywords").split(/\s+/).filter(Boolean),
      run: openPrPanel,
    },
  ];
}
