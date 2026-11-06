import { Button, Dialog } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { LinksTarget } from "@/api";
import { useI18n } from "@/i18n";
import { answerLinksChoice, useLinksChoicePending } from "./linksChoice";

/** The question: the in-app browser is the primary choice, the system browser the quiet one; Esc answers nothing. */
export function LinksChoiceView(props: { onChoose(target: LinksTarget): void; onCancel(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog modal title={t("linksChoice.title")} cancelLabel={null} confirmLabel={t("linksChoice.pane")} onConfirm={() => props.onChoose("pane")} onCancel={props.onCancel} body="plain">
      <p className="tip-text">{t("linksChoice.body")}</p>
      <div className="settings-actions settings-actions-start tip-actions">
        <Button type="button" variant="secondary" onClick={() => props.onChoose("system")}>
          {t("linksChoice.system")}
        </Button>
      </div>
      <p className="tip-text">{t("linksChoice.hint")}</p>
    </Dialog>
  );
}

/** Shows the question while a terminal link click waits for the answer. */
export function LinksChoiceHost(): JSX.Element | null {
  const pending = useLinksChoicePending();
  if (!pending) return null;
  return <LinksChoiceView onChoose={answerLinksChoice} onCancel={() => answerLinksChoice(null)} />;
}
