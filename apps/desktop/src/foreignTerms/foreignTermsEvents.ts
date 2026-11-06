import type { PaletteItem } from "@/palette/items";

const openers = new Set<() => void>();

/** Asks the host to open "Terminals on this machine". Nothing happens when it is not mounted. */
export function openForeignTerms(): void {
  for (const cb of [...openers]) cb();
}

/** The host listens here. Returns the unsubscribe. */
export function onForeignTermsOpen(cb: () => void): () => void {
  openers.add(cb);
  return () => void openers.delete(cb);
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The palette's way in. */
export function foreignTermsItems(t: T): PaletteItem[] {
  return [
    {
      id: "foreign-terms:open",
      kind: "action",
      title: t("foreignTerms.palette"),
      keywords: t("foreignTerms.palette.keywords").split(/\s+/).filter(Boolean),
      run: openForeignTerms,
    },
  ];
}
