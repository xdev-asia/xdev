import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon, type MenuEntry } from "@xdev-asia/ui";
import type { Agent, SessionRow, SessionScope, SessionSort } from "@/api";
import { MenuButton } from "@/automations/MenuButton";
import { renderSnippet } from "@/components/renderSnippet";
import { useI18n } from "@/i18n";
import { AgentIcon } from "@/workspace/AgentIcon";
import { ago } from "@/workspace/ago";
import { DragController } from "./dragToResume";
import { rowMenuItems } from "./rowMenu";
import { baseName, GROUP_BYS, groupRows, HISTORY_DAYS, type SessionGroup } from "./sessionsView";
import { DEFAULT_VIEW, type AgentSessionsState, type ViewPrefs } from "./store";

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
  /** How rows are grouped and limited; the defaults when absent. */
  view?: ViewPrefs;
  onView?(patch: Partial<ViewPrefs>): void;
  /** Open the hand-off dialog for a row; without it the menu has no Hand off. */
  onHandOff?(row: SessionRow): void;
  /** Put a row's resume command on the clipboard. */
  onCopyCommand?(command: string): void;
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
  const [dragging, setDragging] = useState<string | null>(null);
  const zone = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const drag = useRef<DragController | null>(null);
  drag.current ??= new DragController({
    zone: () => zone.current?.getBoundingClientRect() ?? null,
    dragging: setDragging,
    drop: (key) => {
      const row = latest.current.state.rows.find((r) => r.session.key === key);
      if (row) latest.current.onPrimary(row, latest.current.openTab(row));
    },
  });
  // Set by a drag's release, so the click the browser sends after it is not a pick.
  const dragged = useRef(false);

  // The pointer is tracked on the window: the drag leaves the row on its way to the zone.
  useEffect(() => {
    const c = drag.current;
    if (!c) return;
    const onMove = (e: PointerEvent) => c.moved(e.clientX, e.clientY);
    const onUp = (e: PointerEvent) => {
      dragged.current = c.up(e.clientX, e.clientY);
    };
    const onCancel = () => c.cancel();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

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
  const view = props.view ?? DEFAULT_VIEW;
  const groups = groupRows(rows, { by: view.groupBy, sort: query.sort, now, history: view.history, hideEmpty: view.hideEmpty });
  const filtered = query.text !== null || query.agent !== null || query.homeId !== null || query.scope.kind !== "all";
  const groupLabel = (g: SessionGroup) =>
    g.kind === "today"
      ? t("agentSessions.day.today")
      : g.kind === "yesterday"
        ? t("agentSessions.day.yesterday")
        : g.kind === "folder"
          ? baseName(g.path) || t("agentSessions.noFolder")
          : g.kind === "agent"
            ? t(`agentSessions.agent.${g.agent}`)
            : new Date(g.at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  const setView = (patch: Partial<ViewPrefs>) => props.onView?.(patch);
  const groupItems: MenuEntry[] = [
    { type: "group", label: t("agentSessions.group.label") },
    ...GROUP_BYS.map((by): MenuEntry => ({ label: t(`agentSessions.group.${by}`), checked: view.groupBy === by, onSelect: () => setView({ groupBy: by }) })),
    { type: "separator" },
    { label: t("agentSessions.group.hideEmpty"), checked: view.hideEmpty, onSelect: () => setView({ hideEmpty: !view.hideEmpty }) },
  ];
  const historyItems: MenuEntry[] = HISTORY_DAYS.map(
    (days): MenuEntry => ({
      label: days === null ? t("agentSessions.history.all") : t("agentSessions.history.days", { count: days }),
      checked: view.history === days,
      onSelect: () => setView({ history: days }),
    }),
  );

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
    const canHandOff = props.onHandOff !== undefined && (row.worktree !== null || canScope.worktree);
    const menu = rowMenuItems(
      row,
      tab,
      t,
      {
        handOff: () => props.onHandOff?.(row),
        copyCommand: (command) => props.onCopyCommand?.(command),
        jump: () => tab !== null && props.onPrimary(row, tab),
      },
      canHandOff,
    );
    const meta = [where, s.branch, s.model].filter((x): x is string => !!x);
    return (
      <li key={s.key} className="as-row" data-key={s.key} data-picked={picked === s.key ? "true" : undefined}>
        <button
          type="button"
          className="as-main"
          aria-label={title}
          onPointerDown={(e) => {
            dragged.current = false;
            if (!blocked && e.button === 0) drag.current?.down(s.key, e.clientX, e.clientY);
          }}
          onClickCapture={(e) => {
            if (!dragged.current) return;
            dragged.current = false;
            e.stopPropagation();
          }}
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
          {row.hit && <span className="as-snippet">{renderSnippet(row.hit)}</span>}
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
        <MenuButton label={t("agentSessions.menu.more")} items={menu} className="as-menu-btn" placement="bottom-end">
          <Icon name="more" />
        </MenuButton>
      </li>
    );
  };

  return (
    <section className="as-panel" aria-label={t("agentSessions.title")} data-dragging={dragging !== null ? "true" : undefined}>
      {dragging !== null && (
        <div ref={zone} className="as-drop" role="status">
          {t("agentSessions.drop")}
        </div>
      )}
      <div className="as-controls">
        <input
          ref={search}
          type="search"
          className="as-search"
          value={text}
          placeholder={t(state.contentSearch ? "sessionSearch.placeholder" : "agentSessions.search.placeholder")}
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
          <MenuButton label={t("agentSessions.group.label")} items={groupItems} className="as-select as-menu" placement="bottom-start">
            {t("agentSessions.group.label")}
          </MenuButton>
          <MenuButton label={t("agentSessions.history.label")} items={historyItems} className="as-select as-menu" placement="bottom-start">
            {t("agentSessions.history.label")}
          </MenuButton>
        </div>
      </div>
      {state.error && (
        <p className="error-text as-error" role="alert">
          {t(`error.${state.error.code}`)}
        </p>
      )}
      {state.reading && (
        <p className="as-status" role="status">
          {t("agentSessions.reading")}
        </p>
      )}
      <div ref={list} className="as-list">
        {groups.map((g) => (
          <div key={g.id} className="as-group">
            <h3 className="as-day" title={g.kind === "folder" && g.path ? g.path : undefined}>
              {groupLabel(g)}
            </h3>
            {g.rows.length === 0 ? <p className="as-none">{t("agentSessions.group.none")}</p> : <ul className="as-rows">{g.rows.map(renderRow)}</ul>}
          </div>
        ))}
        {rows.length === 0 && state.loading && !state.reading && <p className="as-empty">{t("agentSessions.indexing")}</p>}
        {rows.length === 0 && !state.loading && !state.reading && !state.error && (
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
