import { COLUMN_IDS, type ColumnId } from "./kanbanModel";

export type Density = "comfortable" | "compact";

/** The board's per-user view: which columns show, and how dense the cards are. */
export interface KanbanSettings {
  hidden: ColumnId[];
  density: Density;
}

export const SETTINGS_KEY = "xdev.kanban.settings";

export const DEFAULT_SETTINGS: KanbanSettings = { hidden: [], density: "comfortable" };

/** Reads stored settings; anything broken or unknown falls back to the defaults. */
export function parseSettings(raw: string | null): KanbanSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return DEFAULT_SETTINGS;
    const { hidden, density } = v as { hidden?: unknown; density?: unknown };
    const ids = Array.isArray(hidden) ? COLUMN_IDS.filter((c) => hidden.includes(c)) : [];
    return {
      // Every column hidden would leave nothing to drop on.
      hidden: ids.length >= COLUMN_IDS.length ? [] : ids,
      density: density === "compact" ? "compact" : "comfortable",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function loadSettings(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): KanbanSettings {
  try {
    return parseSettings(storage?.getItem(SETTINGS_KEY) ?? null);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: KanbanSettings, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A view preference: losing it is fine.
  }
}

/** Shows or hides a column. The last visible column cannot be hidden: `settings` comes back as is. */
export function toggleColumn(settings: KanbanSettings, column: ColumnId): KanbanSettings {
  if (settings.hidden.includes(column)) return { ...settings, hidden: settings.hidden.filter((c) => c !== column) };
  if (settings.hidden.length >= COLUMN_IDS.length - 1) return settings;
  return { ...settings, hidden: COLUMN_IDS.filter((c) => c === column || settings.hidden.includes(c)) };
}
