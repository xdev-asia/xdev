import type { PaletteItem } from "@/palette/items";

/** What to open: Mission Control on one of its views, or the hand-off dialog from a tab. */
export type MissionOpen = { kind: "mission"; view: "tabs" | "map" } | { kind: "handoff"; from: string | null };

const openers = new Set<(open: MissionOpen) => void>();

/** Asks the host to open Mission Control. Nothing happens when it is not mounted. */
export function openMissionControl(view: "tabs" | "map" = "tabs"): void {
  for (const cb of [...openers]) cb({ kind: "mission", view });
}

/** Asks the host to open the hand-off dialog; `from` is the sending tab, or null for the tab in front. */
export function openHandoff(from: string | null = null): void {
  for (const cb of [...openers]) cb({ kind: "handoff", from });
}

/** The host listens here. Returns the unsubscribe. */
export function onMissionOpen(cb: (open: MissionOpen) => void): () => void {
  openers.add(cb);
  return () => void openers.delete(cb);
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The palette's ways in: Mission Control, the team map and a hand-off. */
export function missionItems(t: T): PaletteItem[] {
  const item = (id: string, key: string, run: () => void): PaletteItem => ({
    id: `mission:${id}`,
    kind: "action",
    title: t(key),
    keywords: t(`${key}.keywords`).split(/\s+/).filter(Boolean),
    run,
  });
  return [
    item("open", "mission.palette.open", () => openMissionControl("tabs")),
    item("map", "mission.palette.map", () => openMissionControl("map")),
    item("handoff", "mission.palette.handoff", () => openHandoff(null)),
  ];
}
