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

export function searchSettings(
  _query: string,
  entries: readonly SettingEntry[],
  _t: (key: string) => string,
  _sectionTitle: (section: string) => string,
): SettingHit[] {
  return entries.map((entry) => ({ entry, score: 0 }));
}
