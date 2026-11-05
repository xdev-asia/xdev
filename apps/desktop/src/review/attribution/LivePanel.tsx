import type { JSX } from "react";
import { AgentChip } from "@xdev-asia/ui";
import type { AttributionEvent } from "@/api";
import { useI18n } from "@/i18n";
import { letterOf, profileOf } from "./attributionModel";

/** The latest attributions of the worktree; a file in it opens in the review. */
export function LivePanel(props: { events: readonly AttributionEvent[]; onOpen(path: string): void }): JSX.Element {
  const { t } = useI18n();
  const { events } = props;
  const latest = events[0];
  return (
    <section className="attr-live" aria-label={t("review.attr.live.title")}>
      {/* Told to a screen reader when a new change comes in; the list below is not re-read. */}
      <p className="attr-sr" role="status">
        {latest ? t("review.attr.live.row", { agent: latest.agent ?? t("review.attr.unknown"), path: latest.path }) : ""}
      </p>
      {events.length === 0 && <p className="ws-empty">{t("review.attr.live.none")}</p>}
      <ul className="attr-live-list">
        {events.map((e) => (
          <li key={`${e.path}\0${e.tabId ?? ""}\0${e.at}`}>
            <button type="button" className="attr-live-row" onClick={() => props.onOpen(e.path)}>
              <AgentChip profile={profileOf(e.agent)} letter={letterOf(e.agent)} title={e.agent ?? t("review.attr.unknown")} />
              <span className="attr-live-path ws-mono">{e.path}</span>
              <time className="attr-live-time" dateTime={new Date(e.at).toISOString()}>
                {new Date(e.at).toLocaleTimeString()}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
