import { PLATFORM, type Platform } from "@/platform";
import { searchSettings, settingEntriesFor } from "./catalog";

export type SearchResult = {
  // A query is set (after trim); false shows everything.
  active: boolean;
  ids: ReadonlySet<string>;
  // Hits per section id, in catalog order of first hit.
  counts: ReadonlyMap<string, number>;
  // The section of the best hit, or null.
  best: string | null;
};

/** Runs the settings search over the catalog and groups the hits by section. */
export function runSearch(query: string, t: (key: string) => string, sectionTitle: (section: string) => string, platform: Platform = PLATFORM): SearchResult {
  const active = query.trim() !== "";
  const hits = searchSettings(query, settingEntriesFor(platform), t, sectionTitle);
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.entry.section, (counts.get(h.entry.section) ?? 0) + 1);
  return { active, ids: new Set(hits.map((h) => h.entry.id)), counts, best: active ? (hits[0]?.entry.section ?? null) : null };
}
