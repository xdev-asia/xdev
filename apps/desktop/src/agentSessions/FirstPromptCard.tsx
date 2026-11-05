import type { JSX } from "react";
import { useI18n } from "@/i18n";

/** Past this many characters the text may not fit four lines, so it gets a Show more toggle. */
export const CLAMP_CHARS = 160;

/** The trimmed first prompt of a session, or `null` when there is none to show. */
export function firstPrompt(title: string | null): string | null {
  const text = title?.trim() ?? "";
  return text === "" ? null : text;
}

/** The first prompt under a selected row: wrapping text (four lines until expanded) and a button that copies it. */
export function FirstPromptCard(props: { text: string; expanded: boolean; copied: boolean; onToggle(): void; onCopy(): void }): JSX.Element {
  const { t } = useI18n();
  const long = props.text.length > CLAMP_CHARS;
  return (
    <div className="as-prompt">
      <span className="as-prompt-eyebrow">{t("agentSessions.firstPrompt.eyebrow")}</span>
      <p className="as-prompt-text" data-clamped={long && !props.expanded ? "true" : undefined}>
        {props.text}
      </p>
      <span className="as-prompt-actions">
        {long && (
          <button type="button" className="as-act as-prompt-more" aria-expanded={props.expanded} onClick={props.onToggle}>
            {t(props.expanded ? "agentSessions.firstPrompt.less" : "agentSessions.firstPrompt.more")}
          </button>
        )}
        <button type="button" className="as-act as-prompt-copy" onClick={props.onCopy}>
          {props.copied ? t("agentSessions.copied") : t("agentSessions.firstPrompt.copy")}
        </button>
      </span>
    </div>
  );
}
