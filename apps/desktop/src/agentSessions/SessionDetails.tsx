import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Banner, Button, DescriptionList } from "@xdev-asia/ui";
import type { SessionRow, SessionTurn } from "@/api";
import { useI18n } from "@/i18n";
import { baseName } from "./sessionsView";

/** The most characters of one turn the pane shows before it cuts the text. */
export const TURN_SHOW_CHARS = 600;

/** `text` cut to `max` characters with an ellipsis; whole when it fits. */
export function clip(text: string, max: number = TURN_SHOW_CHARS): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("").trimEnd()}…`;
}

export interface SessionDetailsProps {
  row: SessionRow;
  /** The last turns of the row's session, oldest first. */
  loadTail(row: SessionRow): Promise<SessionTurn[]>;
  /** Open the raw log file. */
  onViewLog(row: SessionRow): void;
  onClose(): void;
}

/** The details of one session: its facts, the latest turns as text, and a way to open the raw log. */
export function SessionDetails(props: SessionDetailsProps): JSX.Element {
  const { row, loadTail } = props;
  const { t, locale } = useI18n();
  const s = row.session;
  const [turns, setTurns] = useState<SessionTurn[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setTurns(null);
    setFailed(false);
    loadTail(row).then(
      (found) => live && setTurns(found),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // The session decides what is read; the callback may be a new function on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.key]);

  const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString(locale) : "—");
  const folder = row.worktree ?? s.cwd;
  return (
    <section className="as-details" aria-label={t("agentSessions.details.title")}>
      <h4 className="as-details-title">{s.title ?? t("agentSessions.untitled")}</h4>
      <DescriptionList
        items={[
          { term: t("agentSessions.details.agent"), value: t(`agentSessions.agent.${s.agent}`) },
          { term: t("agentSessions.details.worktree"), value: folder ? baseName(folder) || folder : "—", mono: true },
          { term: t("agentSessions.details.started"), value: when(s.first) },
          { term: t("agentSessions.details.updated"), value: when(s.last) },
        ]}
      />
      <span className="as-prompt-eyebrow">{t("agentSessions.details.latest")}</span>
      {failed ? (
        <p className="as-none" role="status">
          {t("agentSessions.details.failed")}
        </p>
      ) : turns === null ? (
        <p className="as-none" role="status">
          {t("agentSessions.details.loading")}
        </p>
      ) : turns.length === 0 ? (
        <p className="as-none">{t("agentSessions.details.noTurns")}</p>
      ) : (
        <ol className="as-turns">
          {turns.map((turn, i) => (
            <li key={i} className="as-turn" data-role={turn.role}>
              <span className="as-turn-role">{t(turn.role === "user" ? "agentSessions.details.you" : "agentSessions.details.agentSaid")}</span>
              <p className="as-turn-text">{clip(turn.text)}</p>
            </li>
          ))}
        </ol>
      )}
      <span className="as-prompt-actions">
        <Button variant="secondary" type="button" onClick={() => props.onViewLog(row)}>
          {t("agentSessions.details.viewLog")}
        </Button>
        <Button variant="secondary" type="button" onClick={props.onClose}>
          {t("agentSessions.details.close")}
        </Button>
      </span>
    </section>
  );
}

/** The inline banner for logs the scan could not use, with a disclosure that lists their paths. */
export function SkippedBanner(props: { count: number; paths: string[] }): JSX.Element | null {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (props.count <= 0) return null;
  return (
    <div className="as-skipped">
      <Banner
        title={t("agentSessions.skipped.title", { count: props.count })}
        action={
          <Button variant="secondary" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("agentSessions.skipped.hide") : t("agentSessions.skipped.show")}
          </Button>
        }
      >
        {t("agentSessions.skipped.body")}
      </Banner>
      {open && (
        <ul className="as-skipped-list">
          {props.paths.slice(0, 20).map((p) => (
            <li key={p} className="as-skipped-path ws-mono">
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
