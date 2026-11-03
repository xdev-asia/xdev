import { useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { SECTIONS } from "./sections";

/** Settings: the list of sections on the left, the chosen one on the right. */
export function SettingsView(props: { api: Api; onChanged(): void; initial?: string; filter?: string }): JSX.Element {
  const { t } = useI18n();
  const [active, setActive] = useState(() => (SECTIONS.some((s) => s.id === props.initial) ? props.initial! : SECTIONS[0].id));
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];
  const { Component } = section;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.label")}>
        <h2 className="settings-nav-title">{t("settings.title")}</h2>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="settings-nav-item"
            aria-current={s.id === section.id ? "page" : undefined}
            onClick={() => setActive(s.id)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </nav>
      <section className="settings-body" aria-label={t(section.labelKey)}>
        <Component key={section.id} api={props.api} onChanged={props.onChanged} filter={props.filter} />
      </section>
    </div>
  );
}
