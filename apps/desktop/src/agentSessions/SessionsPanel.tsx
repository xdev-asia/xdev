import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Agent, SessionRow, SessionScope, SessionSort } from "@/api";
import { useI18n } from "@/i18n";
import { AgentIcon } from "@/workspace/AgentIcon";
import { ago } from "@/workspace/ago";
import type { AgentSessionsState } from "./store";
import { baseName, groupByDay } from "./sessionsView";

export type ScopeKind = SessionScope["kind"];

export interface SessionsPanelProps {
  state: AgentSessionsState;
  now: number;
  /** Which scopes the person can pick: the first two need a worktree on screen. */
  canScope: { worktree: boolean; repo: boolean };
  /** The tab that already runs a row's session, if any; the row then offers "Open". */
  openTab(row: SessionRow): string | null;
  /** A new value asks the search box for the keyboard. */
  focusSeq?: number;
  /** A session key to scroll to and mark; a new `seq` is a new request. */
  reveal?: { key: string; seq: number } | null;
  onSearch(text: string): void;
  onScope(kind: ScopeKind): void;
  onSort(sort: SessionSort): void;
  onAgent(agent: Agent | null): void;
  onHome(homeId: string | null): void;
  onMore(): void;
  /** Resume a row, or (`tab` set) bring its open tab forward. */
  onPrimary(row: SessionRow, tab: string | null): void;
  onCopyId(row: SessionRow): void;
  onGoTo(row: SessionRow): void;
}

/** The sessions of every agent home on this machine: search, scope, sort, and a resume on each row. */
export function SessionsPanel(props: SessionsPanelProps): JSX.Element {
  const { state, now, canScope } = props;
  const { t, locale } = useI18n();
  const [text, setText] = useState(state.query.text ?? "");
  const [picked, setPicked] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const seen = useRef(props.focusSeq);

  useEffect(() => {
    if (props.focusSeq === seen.current) return;
    seen.current = props.focusSeq;
    if (props.focusSeq) search.current?.focus();
  }, [props.focusSeq]);

  const revealKey = props.reveal?.key;
  const revealSeq = props.reveal?.seq;
  useEffect(() => {
    if (!revealKey) return;
    setPicked(revealKey);
    const el = [...(list.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [])].find((x) => x.dataset.key === revealKey);
    el?.scrollIntoView?.({ block: "center" });
    el?.querySelector<HTMLElement>(".as-main")?.focus();
  }, [revealKey, revealSeq]);

  const { query, rows } = state;
  const groups = groupByDay(rows, query.sort, now);
  const filtered = query.text !== null || query.agent !== null || query.homeId !== null || query.scope.kind !== "all";
  const dayLabel = (g: (typeof groups)[number]) =>
    g.kind === "today"
      ? t("agentSessions.day.today")
      : g.kind === "yesterday"
        ? t("agentSessions.day.yesterday")
        : new Date(g.at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  const scopes: { kind: ScopeKind; label: string; enabled: boolean }[] = [
    { kind: "worktree", label: t("agentSessions.scope.worktree"), enabled: canScope.worktree },
    { kind: "repo", label: t("agentSessions.scope.project"), enabled: canScope.repo },
    { kind: "all", label: t("agentSessions.scope.all"), enabled: true },
  ];

  const renderRow = (row: SessionRow): JSX.Element => {
    const s = row.session;
    const tab = props.openTab(row);
    const title = s.title ?? t("agentSessions.untitled");
    const where = baseName(row.worktree ?? s.cwd ?? "");
    const blocked = tab === null && !row.resumable;
    const primary = () => {
      if (!blocked) props.onPrimary(row, tab);
    };
    const meta = [where, s.branch, s.model].filter((x): x is string => !!x);
    return (
      <li key={s.key} className="as-row" data-key={s.key} data-picked={picked === s.key ? "true" : undefined}>
        <button
          type="button"
          className="as-main"
          aria-label={title}
          onClick={() => setPicked(s.key)}
          onDoubleClick={primary}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            primary();
          }}
        >
          <span className="as-line">
            <AgentIcon profile={s.agent} />
            <span className={s.title === null ? "as-title as-untitled" : "as-title"}>{title}</span>
          </span>
          <span className="as-sub">
            {meta.map((m, i) => (
              <span key={i} className="as-meta" title={i === 0 ? (row.worktree ?? s.cwd ?? undefined) : undefined}>
                {m}
              </span>
            ))}
            <span className="as-time">{ago(s.last, now, t)}</span>
            <span className="as-count">{t("agentSessions.messages", { count: s.messages })}</span>
          </span>
        </button>
        <span className="as-actions">
          <button
            type="button"
            className="as-act as-primary"
            aria-disabled={blocked ? "true" : undefined}
            title={blocked ? t("agentSessions.notResumable") : undefined}
            onClick={primary}
          >
            {tab !== null ? t("agentSessions.open") : t("agentSessions.resume")}
          </button>
          <button
            type="button"
            className="as-act"
            onClick={() => {
              props.onCopyId(row);
              setCopied(s.key);
            }}
          >
            {copied === s.key ? t("agentSessions.copied") : t("agentSessions.copyId")}
          </button>
          {row.worktree && (
            <button type="button" className="as-act" onClick={() => props.onGoTo(row)}>
              {t("agentSessions.goTo")}
            </button>
          )}
        </span>
      </li>
    );
  };

  return (
    <section className="as-panel" aria-label={t("agentSessions.title")}>
      <div className="as-controls">
        <input
          ref={search}
          type="search"
          className="as-search"
          value={text}
          placeholder={t("agentSessions.search.placeholder")}
          aria-label={t("agentSessions.search.label")}
          onChange={(e) => {
            setText(e.target.value);
            props.onSearch(e.target.value);
          }}
        />
        <div className="as-scope" role="group" aria-label={t("agentSessions.scope.label")}>
          {scopes.map((s) => (
            <button
              key={s.kind}
              type="button"
              className="as-seg"
              aria-pressed={query.scope.kind === s.kind}
              disabled={!s.enabled}
              onClick={() => props.onScope(s.kind)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="as-filters">
          <select className="as-select" aria-label={t("agentSessions.sort.label")} value={query.sort} onChange={(e) => props.onSort(e.target.value as SessionSort)}>
            <option value="lastDesc">{t("agentSessions.sort.last")}</option>
            <option value="firstDesc">{t("agentSessions.sort.first")}</option>
          </select>
          <select
            className="as-select"
            aria-label={t("agentSessions.agent.label")}
            value={query.agent ?? ""}
            onChange={(e) => props.onAgent(e.target.value === "" ? null : (e.target.value as Agent))}
          >
            <option value="">{t("agentSessions.agent.all")}</option>
            <option value="claude">{t("agentSessions.agent.claude")}</option>
            <option value="codex">{t("agentSessions.agent.codex")}</option>
          </select>
          {state.homes.length > 1 && (
            <select className="as-select" aria-label={t("agentSessions.home.label")} value={query.homeId ?? ""} onChange={(e) => props.onHome(e.target.value === "" ? null : e.target.value)}>
              <option value="">{t("agentSessions.home.all")}</option>
              {state.homes.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {state.error && (
        <p className="error-text as-error" role="alert">
          {t(`error.${state.error.code}`)}
        </p>
      )}
      <div ref={list} className="as-list">
        {groups.map((g) => (
          <div key={g.id} className="as-group">
            <h3 className="as-day">{dayLabel(g)}</h3>
            <ul className="as-rows">{g.rows.map(renderRow)}</ul>
          </div>
        ))}
        {rows.length === 0 && state.loading && <p className="as-empty">{t("agentSessions.indexing")}</p>}
        {rows.length === 0 && !state.loading && !state.error && (
          <p className="as-empty">{filtered ? t("agentSessions.noMatch") : t("agentSessions.empty")}</p>
        )}
        {state.more && (
          <button type="button" className="as-more" onClick={props.onMore}>
            {t("agentSessions.more")}
          </button>
        )}
      </div>
    </section>
  );
}
