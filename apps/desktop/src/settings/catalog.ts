/** One searchable control (or list) of a Settings page. */
export type SettingEntry = {
  id: string; // "terminal.fontSize"; unique; [a-zA-Z0-9.]+
  section: string; // a SECTIONS id
  titleKey: string; // i18n key the page already shows
  descriptionKey?: string;
  keywords: readonly string[]; // English and Vietnamese words, lower case
};

export const SETTING_ENTRIES: readonly SettingEntry[] = [];

/** The longest query searched, in bytes after trim; longer input is cut. */
export const QUERY_MAX = 2048;

export type SettingHit = { entry: SettingEntry; score: number };

// exact / prefix / contains of the text, or 0
function grade(text: string, q: string, [exact, prefix, contains]: readonly [number, number, number]): number {
  const x = text.toLowerCase();
  if (x === q) return exact;
  if (x.startsWith(q)) return prefix;
  return x.includes(q) ? contains : 0;
}

/** The query as searched: trimmed, lower case, at most QUERY_MAX bytes (cut on a character edge). */
function normalize(query: string): string {
  let q = query.trim().toLowerCase();
  const enc = new TextEncoder();
  while (q.length > 0 && enc.encode(q).length > QUERY_MAX) q = q.slice(0, Math.max(0, q.length - Math.ceil((enc.encode(q).length - QUERY_MAX) / 3)));
  return q.trim();
}

/**
 * Entries that match, best first. A section title match counts for every entry of that section.
 * An empty query returns every entry with score 0, in catalog order. No diacritic folding.
 */
export function searchSettings(
  query: string,
  entries: readonly SettingEntry[],
  t: (key: string) => string,
  sectionTitle: (section: string) => string,
): SettingHit[] {
  const q = normalize(query);
  if (!q) return entries.map((entry) => ({ entry, score: 0 }));
  const hits: (SettingHit & { at: number })[] = [];
  entries.forEach((entry, at) => {
    const score = Math.max(
      grade(sectionTitle(entry.section), q, [900, 850, 800]),
      grade(t(entry.titleKey), q, [700, 650, 600]),
      entry.descriptionKey ? grade(t(entry.descriptionKey), q, [500, 450, 400]) : 0,
      ...entry.keywords.map((k) => grade(k, q, [300, 250, 200])),
    );
    if (score > 0) hits.push({ entry, score, at });
  });
  hits.sort((a, b) => b.score - a.score || a.at - b.at);
  return hits.map(({ entry, score }) => ({ entry, score }));
}
