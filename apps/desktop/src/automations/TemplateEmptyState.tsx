import type { JSX } from "react";
import { EmptyState } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { TEMPLATES, type AutomationTemplate } from "./templates";

/** The empty page: the templates, each one a way to start. */
export function TemplateEmptyState(props: { onPick(template: AutomationTemplate): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <EmptyState
      size="center"
      title={t("automations.templates.title")}
      hint={t("automations.templates.body")}
      actions={
        <ul className="au-templates" aria-label={t("automations.templates.title")}>
          {TEMPLATES.map((tpl) => (
            <li key={tpl.id}>
              <button type="button" className="au-template" data-act="template" data-template={tpl.id} onClick={() => props.onPick(tpl)}>
                <span className="au-template-label">{t(`automations.templates.${tpl.id}.label`)}</span>
                <span className="au-template-desc">{t(`automations.templates.${tpl.id}.description`)}</span>
                <span className="au-template-cat">{t(`automations.templates.category.${tpl.category}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      }
    />
  );
}
