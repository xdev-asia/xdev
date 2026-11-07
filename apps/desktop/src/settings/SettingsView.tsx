import { useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { useI18n } from "@/i18n";
import { entriesFor } from "./catalog";
import { PLATFORM } from "@/platform";
import { GROUPS, SECTIONS, type SettingsFilter } from "./sections";
import { RevealSetting, SettingsSearch } from "./SettingsSearch";
import { runSearch } from "./searchModel";

/** Settings: the search and the list of sections on the left, the chosen one on the right. */
export function SettingsView(props: { api: Api; onChanged(): void; initial?: string; arg?: string; target?: string; openView?(view: string): void; openTerminal?(profile: string, title: string): string | null }): JSX.Element {
  const { t } = useI18n();
  const [active, setActive] = useState(() => (SECTIONS.some((s) => s.id === props.initial) ? props.initial! : SECTIONS[0].id));
  const [query, setQuery] = useState("");
  const found = runSearch(query, t, (id) => t(SECTIONS.find((s) => s.id === id)?.labelKey ?? id));
  const visible = found.active ? SECTIONS.filter((s) => found.counts.has(s.id)) : SECTIONS;
  // The chosen section when it has a hit; else the section of the best hit.
  const section = visible.find((s) => s.id === active) ?? visible.find((s) => s.id === found.best) ?? (found.active ? null : SECTIONS[0]);
  let filter: SettingsFilter | undefined;
  if (found.active) filter = { query, ids: found.ids };
  else if (props.target) filter = { query: "", ids: new Set(entriesFor(PLATFORM).map((e) => e.id)), target: props.target };
  // A section's link to another one (General → Open In Apps); a typed query would hide the target, so it clears.
  const openSection = (id: string) => {
    if (!SECTIONS.some((s) => s.id === id)) return;
    setQuery("");
    setActive(id);
  };
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.label")}>
        <h2 className="settings-nav-title">{t("settings.title")}</h2>
        <SettingsSearch value={query} onChange={setQuery} />
        {GROUPS.map((g) => {
          const items = visible.filter((s) => s.group === g.id);
          if (items.length === 0) return null;
          return (
            <div key={g.id} className="settings-nav-group" role="group" aria-label={t(g.labelKey)}>
              <h3 className="settings-nav-heading">{t(g.labelKey)}</h3>
              {items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="settings-nav-item"
                  aria-current={s.id === section?.id ? "page" : undefined}
                  onClick={() => setActive(s.id)}
                >
                  {found.active ? [t(s.labelKey), <span key="n" className="settings-nav-count" title={t("settings.search.hits", { count: found.counts.get(s.id) ?? 0 })}>{found.counts.get(s.id)}</span>] : t(s.labelKey)}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      {section ? (
        <section className="settings-body" aria-label={t(section.labelKey)}>
          <SurfaceBoundary id="page.settings" surface={`Settings: ${section.id}`} resetKey={section.id} titleKey="boundary.page.title">
            <section.Component key={section.id} api={props.api} onChanged={props.onChanged} arg={props.arg} filter={filter} openSection={openSection} openView={props.openView} openTerminal={props.openTerminal} />
          </SurfaceBoundary>
          {props.target && !found.active && <RevealSetting id={props.target} />}
        </section>
      ) : (
        <section className="settings-body" aria-label={t("settings.title")}>
          <p className="settings-empty" role="status" data-search="none">
            {t("settings.search.none", { query: query.trim() })}
          </p>
        </section>
      )}
    </div>
  );
}
