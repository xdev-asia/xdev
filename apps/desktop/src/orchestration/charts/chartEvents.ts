import type { Chart } from "@/api";
import type { PaletteItem } from "@/palette/items";

/** What to open: the chart list, or the editor on `draft` (a chart to save, from a squad or the team map). */
export type ChartsOpen = { draft: Chart | null };

const openers = new Set<(open: ChartsOpen) => void>();

/** Asks the host to open team charts. Nothing happens when it is not mounted; returns whether one listened. */
export function openTeamCharts(draft: Chart | null = null): boolean {
  for (const cb of [...openers]) cb({ draft });
  return openers.size > 0;
}

/** The host listens here. Returns the unsubscribe. */
export function onChartsOpen(cb: (open: ChartsOpen) => void): () => void {
  openers.add(cb);
  return () => void openers.delete(cb);
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The palette's way in. */
export function chartItems(t: T): PaletteItem[] {
  return [
    {
      id: "charts:open",
      kind: "action",
      title: t("charts.palette.open"),
      keywords: t("charts.palette.open.keywords").split(/\s+/).filter(Boolean),
      run: () => void openTeamCharts(null),
    },
  ];
}
