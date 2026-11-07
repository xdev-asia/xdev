import { orderedApps, type AppId } from "./apps";

/** The places of the one shell: the rail shows them, each owns the side list and the stage. */
export type Place = "workspace" | "docs" | "tasks" | "squads" | "kit" | "accounts" | "automations" | "settings";

/** The sections of the Docs side list. */
export type DocsSection = "docs" | "changes" | "agents";

/** Where each former inner app lives now. `terminal` was a duplicate of the Workspace place. */
export const APP_HOME: Record<AppId, { place: Place; section?: DocsSection } | "dropped"> = {
  docs: { place: "docs", section: "docs" },
  changes: { place: "docs", section: "changes" },
  tasks: { place: "tasks" },
  squads: { place: "squads" },
  agents: { place: "docs", section: "agents" },
  kit: { place: "kit" },
  accounts: { place: "accounts" },
  terminal: "dropped",
};

/** The apps that became rail places Settings can hide and reorder. */
export const MOVABLE: readonly AppId[] = ["tasks", "squads", "kit", "accounts"];

/** Workspace and Docs always lead; the movable places follow in the saved order, minus the hidden ones (hiding all shows all). */
export function railPlaces(hidden: readonly AppId[] | readonly string[], order: readonly string[], automations: boolean): Place[] {
  const ordered = orderedApps(order).filter((id) => (MOVABLE as readonly string[]).includes(id));
  const shown = ordered.filter((id) => !hidden.includes(id));
  const movable = (shown.length > 0 ? shown : ordered) as Place[];
  return ["workspace", "docs", ...movable, ...(automations ? (["automations"] as Place[]) : [])];
}

/** Docs first, then Changes and Agent context in the saved order, minus the hidden ones. */
export function docsSections(hidden: readonly AppId[] | readonly string[], order: readonly string[]): DocsSection[] {
  const rest = orderedApps(order).filter((id): id is "changes" | "agents" => (id === "changes" || id === "agents") && !hidden.includes(id));
  return ["docs", ...rest];
}
