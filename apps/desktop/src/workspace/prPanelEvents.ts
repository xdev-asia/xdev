import type { PaletteItem } from "@/palette/items";

const openers = new Set<() => void>();
const pageOpeners = new Set<() => void>();

/** Asks the shell to open the pull request panel of the current worktree. Nothing happens when it is not mounted. */
export function openPrPanel(): void {
  for (const cb of [...openers]) cb();
}

/** The shell listens here. Returns the unsubscribe. */
export function onPrPanelOpen(cb: () => void): () => void {
  openers.add(cb);
  return () => void openers.delete(cb);
}

/** Asks the shell to open the pull request of the current worktree as a full page, in a workspace tab. */
export function openPrPage(): void {
  for (const cb of [...pageOpeners]) cb();
}

/** The shell listens here. Returns the unsubscribe. */
export function onPrPageOpen(cb: () => void): () => void {
  pageOpeners.add(cb);
  return () => void pageOpeners.delete(cb);
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
    {
      id: "pr-page:open",
      kind: "action",
      title: t("prPanel.page.palette"),
      keywords: t("prPanel.page.palette.keywords").split(/\s+/).filter(Boolean),
      run: openPrPage,
    },
  ];
}
