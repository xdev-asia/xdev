import type { JSX } from "react";
import { useI18n } from "@/i18n";
import type { AiSnapshot } from "./aiReview";

/**
 * What the AI review is doing, as one polite status line with Cancel while it runs, one inline error when
 * it stopped, and the changes it left out.
 */
export function AiStatus(props: { state: AiSnapshot; onCancel(): void }): JSX.Element | null {
  const { state, onCancel } = props;
  const { t } = useI18n();
  const { phase } = state;
  const busy = phase === "planning" || phase === "running";
  let text = "";
  if (phase === "planning") text = t("review.ai.planning");
  else if (phase === "running") text = t("review.ai.progress", { done: Math.min(state.done + 1, state.total), total: state.total });
  else if (phase === "done") text = state.total === 0 && state.skipped.length === 0 ? t("review.ai.nothing") : t("review.ai.done", { count: state.notes.length });
  else if (phase === "cancelled") text = t("review.ai.cancelled", { done: state.done, total: state.total });
  if (phase === "idle" && state.skipped.length === 0) return null;
  return (
    <div className="rv-ai">
      <span className="rv-ai-status" role="status">
        {text}
      </span>
      {busy && (
        <button type="button" className="rv-base-button" data-act="ai-cancel" onClick={onCancel}>
          {t("review.ai.cancel")}
        </button>
      )}
      {phase === "error" && state.error && (
        <p className="error-text" role="alert">
          {t("review.ai.error", { error: t(`error.${state.error.code}`) })}
        </p>
      )}
      {state.skipped.length > 0 && !busy && (
        <details className="rv-ai-skipped">
          <summary>{t("review.ai.skipped", { count: state.skipped.length })}</summary>
          <ul>
            {state.skipped.map((s, i) => (
              <li key={`${s.file}:${i}`}>
                <span className="ws-mono">{s.file}</span> {t(`review.ai.skip.${s.reason}`)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
