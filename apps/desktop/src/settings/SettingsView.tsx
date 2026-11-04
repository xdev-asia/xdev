import { useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { SETTING_ENTRIES } from "./catalog";
import { SECTIONS, type SettingsFilter } from "./sections";
import { RevealSetting, SettingsSearch } from "./SettingsSearch";
import { runSearch } from "./searchModel";

/** Settings: the search and the list of sections on the left, the chosen one on the right. */
export function SettingsView(props: { api: Api; onChanged(): void; initial?: string; arg?: string; target?: string }): JSX.Element {
  const { t } = useI18n();
  const [active, setActive] = useState(() => (SECTIONS.some((s) => s.id === props.initial) ? props.initial! : SECTIONS[0].id));
  const [query, setQuery] = useState("");
  const found = runSearch(query, t, (id) => t(SECTIONS.find((s) => s.id === id)?.labelKey ?? id));
  const visible = found.active ? SECTIONS.filter((s) => found.counts.has(s.id)) : SECTIONS;
  // The chosen section when it has a hit; else the section of the best hit.
  const section = visible.find((s) => s.id === active) ?? visible.find((s) => s.id === found.best) ?? (found.active ? null : SECTIONS[0]);
  let filter: SettingsFilter | undefined;
  if (found.active) filter = { query, ids: found.ids };
  else if (props.target) filter = { query: "", ids: new Set(SETTING_ENTRIES.map((e) => e.id)), target: props.target };
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.label")}>
        <h2 className="settings-nav-title">{t("settings.title")}</h2>
        <SettingsSearch value={query} onChange={setQuery} />
        {visible.map((s) => (
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
      </nav>
      {section ? (
        <section className="settings-body" aria-label={t(section.labelKey)}>
          <section.Component key={section.id} api={props.api} onChanged={props.onChanged} arg={props.arg} filter={filter} />
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
