import type { TerminalSettings } from "@/api";
import type { SettingsFilter } from "../sections";

/** What Settings → Terminal gives each of its section files. */
export type TerminalSectionProps = {
  current: TerminalSettings;
  busy: boolean;
  /** Writes `{ ...current, ...change }`; the page shows what Rust stored. */
  patch(change: Partial<TerminalSettings>): Promise<void>;
  filter?: SettingsFilter;
};

/** A number typed in a box: rounded to `places` decimals, or null when it is no number. */
export function parseNumber(raw: string, places: number): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
