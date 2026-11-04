import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SETTING_ENTRIES } from "./catalog";

// Each page and the section it holds. A control without an entry, or an entry without a control,
// fails here. The source is scanned, not rendered: pages load their data async and need a store.
const PAGES: Record<string, string[]> = {
  general: ["GeneralPage.tsx", "UpdatesSetting.tsx"],
  appearance: ["AppearancePage.tsx"],
  agents: ["agents/AgentsPage.tsx"],
  usage: ["UsagePage.tsx"],
  notifications: ["notifications/NotificationsPage.tsx"],
  terminal: ["TerminalPage.tsx", "terminal/TerminalLookSection.tsx", "terminal/TerminalBehaviourSection.tsx"],
  editor: ["EditorPage.tsx"],
  repos: ["ReposSettings.tsx"],
  openIn: ["OpenInPage.tsx"],
  git: ["GitSettings.tsx"],
  vaults: ["VaultsSettings.tsx"],
  keys: ["shortcuts/ShortcutsPage.tsx"],
  qcmd: ["quickCommands/QuickCommandsPage.tsx"],
};
const here = dirname(fileURLToPath(import.meta.url));
const USED = /(?:<SettingRow\s+id=|settingShown\(\s*[\w.]+\s*,\s*)(?:"([^"]+)"|\{?`([^`$]+)\$\{)/g;

function used(section: string): { ids: Set<string>; prefixes: string[] } {
  const ids = new Set<string>();
  const prefixes: string[] = [];
  for (const file of PAGES[section]) {
    for (const m of readFileSync(join(here, file), "utf8").matchAll(USED)) {
      if (m[1]) ids.add(m[1]);
      else prefixes.push(m[2]);
    }
  }
  return { ids, prefixes };
}

for (const section of Object.keys(PAGES)) {
  it(`${section}: every catalog entry has a row on its page and every row has an entry`, () => {
    const { ids, prefixes } = used(section);
    const entries = SETTING_ENTRIES.filter((x) => x.section === section).map((x) => x.id);
    for (const id of entries) {
      expect(ids.has(id) || prefixes.some((p) => id.startsWith(p)), `no row for ${id}`).toBe(true);
    }
    for (const id of ids) expect(entries, `no entry for row ${id}`).toContain(id);
    for (const p of prefixes) expect(entries.some((id) => id.startsWith(p)), `no entry for ${p}…`).toBe(true);
  });
}
