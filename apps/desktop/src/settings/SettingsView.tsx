import { useState } from "react";
import type { JSX } from "react";
import { SaveBar, SettingsShell, useUnsavedGuard, type SettingsShellGroup } from "@xdev-asia/ui";
import type { Api } from "@/api";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { useI18n } from "@/i18n";
import { entriesFor } from "./catalog";
import { PLATFORM } from "@/platform";
import { GROUPS, SECTIONS, type SaveSpec, type SettingsFilter } from "./sections";
import { RevealSetting, useFindShortcut } from "./SettingsSearch";
import { runSearch } from "./searchModel";

/** The words the shell's search matches for a section: its title and every searchable control in it. */
function sectionKeywords(sectionId: string, t: (key: string) => string): string[] {
  const words: string[] = [];
  for (const e of entriesFor(PLATFORM)) {
    if (e.section !== sectionId) continue;
    words.push(t(e.titleKey), ...e.keywords);
    if (e.descriptionKey) words.push(t(e.descriptionKey));
  }
  return words;
}

/** The six groups of the Settings list, each with its sections as items. */
export function settingsGroups(t: (key: string) => string): SettingsShellGroup[] {
  return GROUPS.map((g) => ({
    id: g.id,
    label: t(g.labelKey),
    items: SECTIONS.filter((s) => s.group === g.id).map((s) => ({ id: s.id, label: t(s.labelKey), keywords: sectionKeywords(s.id, t) })),
  }));
}

/**
 * Settings: the design system's SettingsShell (search over six groups, the chosen section in the
 * middle) with one SaveBar that shows only while the open page has unsaved changes. Section ids are
 * the deep-link ids; an unknown one opens the first section.
 */
export function SettingsView(props: { api: Api; onChanged(): void; initial?: string; arg?: string; target?: string; openView?(view: string): void; openTerminal?(profile: string, title: string): string | null }): JSX.Element {
  const { t } = useI18n();
  const [active, setActive] = useState(() => (SECTIONS.some((s) => s.id === props.initial) ? props.initial! : SECTIONS[0].id));
  const [query, setQuery] = useState("");
  // What the opener (or a link between sections) asked the section to start with.
  const [arg, setArg] = useState(props.arg);
  // What the open page said about its unsaved changes.
  const [save, setSave] = useState<SaveSpec | null>(null);
  const { confirmLeave } = useUnsavedGuard(save?.dirty === true, t("settings.v2.save.leave"));
  useFindShortcut();
  const found = runSearch(query, t, (id) => t(SECTIONS.find((s) => s.id === id)?.labelKey ?? id));
  const visible = found.active ? SECTIONS.filter((s) => found.counts.has(s.id)) : SECTIONS;
  // The chosen section when it has a hit; else the section of the best hit.
  const section = visible.find((s) => s.id === active) ?? visible.find((s) => s.id === found.best) ?? (found.active ? null : SECTIONS[0]);
  let filter: SettingsFilter | undefined;
  if (found.active) filter = { query, ids: found.ids };
  else if (props.target) filter = { query: "", ids: new Set(entriesFor(PLATFORM).map((e) => e.id)), target: props.target };
  const choose = (id: string, next?: string): void => {
    if (id !== section?.id && !confirmLeave()) return;
    setSave(null);
    setArg(next);
    setActive(id);
  };
  // A section's link to another one (General → Open In Apps); a typed query would hide the target, so it clears.
  const openSection = (id: string, next?: string): void => {
    if (!SECTIONS.some((s) => s.id === id)) return;
    setQuery("");
    choose(id, next);
  };
  const bar = save && (
    <SaveBar
      dirty={save.dirty}
      busy={save.busy}
      saveDisabled={save.saveDisabled}
      onSave={save.onSave}
      onDiscard={save.onDiscard}
      labels={{ unsaved: t("settings.v2.save.unsaved"), save: t("settings.v2.save.save"), discard: t("settings.v2.save.discard"), saving: t("settings.v2.save.saving") }}
    />
  );
  return (
    <div className="settings">
      <SettingsShell
        groups={settingsGroups(t)}
        value={section?.id ?? ""}
        onChange={(id) => choose(id)}
        query={query}
        onQuery={setQuery}
        saveBar={bar}
        labels={{
          search: t("settings.search.placeholder"),
          clear: t("settings.search.clear"),
          count: (n) => t("settings.search.hits", { count: n }),
          empty: (q) => t("settings.search.none", { query: q }),
        }}
      >
        {section ? (
          <section className="settings-section" aria-label={t(section.labelKey)}>
            <SurfaceBoundary id="page.settings" surface={`Settings: ${section.id}`} resetKey={section.id} titleKey="boundary.page.title">
              <section.Component key={section.id} api={props.api} onChanged={props.onChanged} arg={arg} filter={filter} openSection={openSection} openView={props.openView} openTerminal={props.openTerminal} registerSave={setSave} />
            </SurfaceBoundary>
            {props.target && !found.active && <RevealSetting id={props.target} />}
          </section>
        ) : (
          <p className="settings-empty" role="status" data-search="none">
            {t("settings.search.none", { query: query.trim() })}
          </p>
        )}
      </SettingsShell>
    </div>
  );
}
