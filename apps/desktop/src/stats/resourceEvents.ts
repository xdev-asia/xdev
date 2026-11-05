import type { PaletteItem } from "@/palette/items";

const openers = new Set<() => void>();

/** Asks the host to open the resource manager. Nothing happens when it is not mounted. */
export function openResourceManager(): void {
  for (const cb of [...openers]) cb();
}

/** The host listens here. Returns the unsubscribe. */
export function onResourceManagerOpen(cb: () => void): () => void {
  openers.add(cb);
  return () => void openers.delete(cb);
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The palette's way in. */
export function resourceItems(t: T): PaletteItem[] {
  return [
    {
      id: "resources:open",
      kind: "action",
      title: t("resources.palette.open"),
      keywords: t("resources.palette.open.keywords").split(/\s+/).filter(Boolean),
      run: openResourceManager,
    },
  ];
}
