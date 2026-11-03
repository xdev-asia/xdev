import { useEffect, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { ApiError, Check, PrView, PtyProfile, RepoView, WorktreeStat, WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import { profileLetter, profileName, useProfiles } from "@/agents/profileStore";
import { ago } from "./ago";
import { groupWorktrees, orderedWorktrees, type Group } from "./groups";
import { checksSummary } from "./ship";
import type { TabStatus } from "./status";
import { StatusGlyph } from "./StatusGlyph";

type T = ReturnType<typeof useI18n>["t"];

/** A worktree with the repo it belongs to; `path` keys the grouping. */
interface Entry {
  path: string;
  wt: WorktreeView;
  repo: RepoView;
}

export interface WorktreeListProps {
  /** Told the paths in the order they are drawn, collapsed groups left out; the worktree keys walk it. */
  onOrder?(paths: string[]): void;
  /** Null while the first list is loading. */
  repos: RepoView[] | null;
  selected: string | null;
  /** The status dot of each worktree path; null shows none. */
  dots: Record<string, TabStatus | null>;
  /** Line counts of each worktree path, once read. */
  stats?: Record<string, WorktreeStat | undefined>;
  /** When each worktree path last produced output; null for none. */
  activity?: Record<string, number | null>;
  /** The profiles open in each worktree path, in tab order. */
  profiles?: Record<string, PtyProfile[]>;
  /** The pull request and checks of each worktree path, once looked at. */
  prs?: Record<string, { pr: PrView | null; checks: Check[] | null }>;
  /** The time the relative times count from; `Date.now()` when left out. */
  now?: number;
  /** Why the last repo or pin action failed. */
  notice?: ApiError["code"];
  onSelect(worktree: WorktreeView): void;
  onCreate(repoId?: string): void;
  onPin(worktree: WorktreeView): void;
  onRemove(worktree: WorktreeView): void;
  onAddRepo(): void;
  /** Takes a worktree made outside xDev into the list; without it the found rows have no button. */
  onAdopt?(worktree: WorktreeView): void;
  /** Worktree paths that are unread: a tab finished or asked while nobody looked, or marked by hand. */
  unread?: Record<string, boolean>;
  /** Marks a worktree unread until one of its panes is next seen; without it the menu has no such item. */
  onMarkUnread?(worktree: WorktreeView): void;
  /** Marks an unread worktree read; the menu offers it in place of "Mark unread" while the row is unread. */
  onMarkRead?(worktree: WorktreeView): void;
}

/** The worktrees of every repo, split into sections by what their agents are doing. */
export function WorktreeList(props: WorktreeListProps): JSX.Element {
  const { t } = useI18n();
  const { view } = useProfiles();
  // The worktree whose action menu is open.
  const [menu, setMenu] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Group[]>([]);
  // The repos whose "Found outside xDev" group is open; all start closed.
  const [foundOpen, setFoundOpen] = useState<string[]>([]);

  const toggle = (group: Group) =>
    setCollapsed(collapsed.includes(group) ? collapsed.filter((c) => c !== group) : [...collapsed, group]);
  const openMenu = (wt: WorktreeView) => setMenu(wt.path);
  const pick = (action: () => void) => {
    setMenu(null);
    action();
  };
  // Arrows, Home and End move between the items; Escape and Tab close the menu
  // from the row's more button, so Tab goes on from there and is never trapped.
  const menuKey = (e: KeyboardEvent<HTMLElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const at = items.indexOf(e.target as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 };
    const to = moves[e.key];
    if (to !== undefined) {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      e.currentTarget.parentElement?.querySelector<HTMLElement>(".ws-wt-more")?.focus();
      setMenu(null);
    }
  };

  // Rows are plain calls, not components, so the list keeps one set of hooks.
  const row = ({ wt, repo }: Entry) => {
    const status = props.dots[wt.path] ?? null;
    const open = menu === wt.path;
    const stat = props.stats?.[wt.path];
    const seen = props.activity?.[wt.path] ?? null;
    // Plain shells are not agents: only the agent profiles get a chip.
    const agents = (props.profiles?.[wt.path] ?? []).filter((p) => !p.startsWith("shell"));
    const counts = stat && (stat.added > 0 || stat.removed > 0) ? stat : null;
    const found = props.prs?.[wt.path];
    const pr = found?.pr ?? null;
    const summary = pr && found?.checks ? checksSummary(found.checks) : null;
    const unread = props.unread?.[wt.path] === true;
    const statusLabel = status ? t(`workspace.status.${status}`) : "";
    return (
      <li key={wt.path} className={unread ? "ws-wt ws-wt-unread" : "ws-wt"} data-path={wt.path}>
        <button
          type="button"
          className="ws-wt-main"
          title={wt.path}
          aria-current={props.selected === wt.path ? "true" : undefined}
          onClick={() => props.onSelect(wt)}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(wt);
          }}
        >
          <span className="ws-wt-line">
            {status ? (
              StatusGlyph({ status, label: unread ? t("workspace.unreadStatus", { status: statusLabel }) : statusLabel })
            ) : unread ? (
              <span className="ws-dot" data-dot="none" role="img" aria-label={t("workspace.unread")} title={t("workspace.unread")} />
            ) : (
              <span className="ws-dot" data-dot="none" aria-hidden="true" />
            )}
            <span className="ws-wt-name" title={wt.name}>
              {wt.name}
            </span>
            {wt.pinned && <PinMark t={t} />}
            {seen !== null && <span className="ws-wt-time">{ago(seen, props.now ?? Date.now(), t)}</span>}
          </span>
          <span className="ws-wt-sub">
            {wt.primary && <span className="ws-tag">{t("workspace.primary")}</span>}
            {many && <span className="ws-tag">{repo.shortName}</span>}
            <span className="ws-wt-branch" title={wt.branch ?? undefined}>
              {wt.branch ?? t("workspace.detached")}
            </span>
          </span>
          {(agents.length > 0 || counts || pr) && (
            <span className="ws-wt-meta">
              {agents.map((p) => (
                <span key={p} className="ws-chip" data-profile={p} title={profileName(view, p, t)}>
                  {profileLetter(view, p)}
                </span>
              ))}
              <span className="ws-wt-spacer" />
              {counts && (
                <span className="ws-stat" title={t("workspace.row.stat", counts)}>
                  <span className="ws-stat-add">{`+${counts.added}`}</span>{" "}
                  <span className="ws-stat-del">{`−${counts.removed}`}</span>
                </span>
              )}
              {pr && (
                <span
                  className="ws-pr"
                  role="img"
                  aria-label={
                    summary
                      ? t("ship.chip.labelChecks", { number: pr.number, state: t(`checks.state.${pr.state}`).toLowerCase(), checks: t(`checks.summary.${summary}`) })
                      : t("ship.chip.label", { number: pr.number, state: t(`checks.state.${pr.state}`).toLowerCase() })
                  }
                >
                  <span className="ws-dot" data-pr={pr.state} aria-hidden="true" />
                  {`#${pr.number}`}
                  {summary && <span className="ws-dot" data-check={summary} aria-hidden="true" />}
                </span>
              )}
            </span>
          )}
        </button>
        <button
          type="button"
          className="ws-wt-more"
          aria-label={t("workspace.more", { name: wt.name })}
          title={t("workspace.more", { name: wt.name })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setMenu(open ? null : wt.path)}
        >
          ⋯
        </button>
        {open && (
          <>
            <div className="ws-menu-backdrop" aria-hidden="true" onClick={() => setMenu(null)} />
            <div
              className="ws-menu"
              role="menu"
              aria-label={t("workspace.more", { name: wt.name })}
              onKeyDown={menuKey}
            >
              <button type="button" role="menuitem" autoFocus onClick={() => pick(() => props.onPin(wt))}>
                {wt.pinned ? t("workspace.unpin") : t("workspace.pin")}
              </button>
              {props.unread?.[wt.path] && props.onMarkRead ? (
                <button type="button" role="menuitem" onClick={() => pick(() => props.onMarkRead?.(wt))}>
                  {t("workspace.markRead")}
                </button>
              ) : (
                props.onMarkUnread && (
                  <button type="button" role="menuitem" onClick={() => pick(() => props.onMarkUnread?.(wt))}>
                    {t("workspace.markUnread")}
                  </button>
                )
              )}
              {/* The primary checkout is the repo itself: it can be pinned but never removed. */}
              {!wt.primary && (
                <button type="button" role="menuitem" className="ws-menu-danger" onClick={() => pick(() => props.onRemove(wt))}>
                  {t("workspace.delete")}
                </button>
              )}
            </div>
          </>
        )}
      </li>
    );
  };

  const entries: Entry[] = (props.repos ?? []).flatMap((repo) => repo.worktrees.map((wt) => ({ path: wt.path, wt, repo })));
  // The repo is named on a row only when more than one repo is listed.
  const many = (props.repos?.length ?? 0) > 1;
  const sections = groupWorktrees(entries, (path) => props.dots[path] ?? null);
  const gone = (props.repos ?? []).filter((repo) => repo.missing);
  const order = orderedWorktrees(sections, collapsed);
  const { onOrder } = props;
  useEffect(() => onOrder?.(order), [order.join(",")]);

  const section = ({ group, items }: { group: Group; items: Entry[] }) => {
    const open = !collapsed.includes(group);
    return (
      <li key={group} className="ws-group" data-group={group}>
        <button type="button" className="ws-group-head" data-group={group} aria-expanded={open} onClick={() => toggle(group)}>
          <svg aria-hidden="true" className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span className={group === "working" ? "ws-group-dot ws-pulse" : "ws-group-dot"} data-group={group} aria-hidden="true" />
          <span className="ws-group-name">{t(`workspace.group.${group}`)}</span>
          <span className="ws-group-count">{items.length}</span>
        </button>
        {open && <ul className="ws-wts">{items.map(row)}</ul>}
      </li>
    );
  };

  const withFound = (props.repos ?? []).filter((repo) => !repo.missing && repo.found.length > 0);
  const foundGroup = (repo: RepoView) => {
    const open = foundOpen.includes(repo.id);
    return (
      <div key={repo.id} className="ws-found" data-repo={repo.id}>
        <button
          type="button"
          className="ws-group-head ws-found-head"
          aria-expanded={open}
          title={t("workspace.found.hint")}
          onClick={() => setFoundOpen(open ? foundOpen.filter((id) => id !== repo.id) : [...foundOpen, repo.id])}
        >
          <svg aria-hidden="true" className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span className="ws-group-name">{t("workspace.found.title", { count: repo.found.length })}</span>
          {many && <span className="ws-tag">{repo.shortName}</span>}
        </button>
        {open && (
          <ul className="ws-found-list">
            {repo.found.map((wt) => (
              <li key={wt.path} className="ws-found-row" title={wt.path}>
                <span className="ws-found-text">
                  <span className="ws-wt-name">{wt.name}</span>
                  <span className="ws-wt-branch">{wt.branch ?? t("workspace.detached")}</span>
                </span>
                {props.onAdopt && (
                  <button
                    type="button"
                    className="btn-secondary ws-found-adopt"
                    aria-label={t("workspace.found.adoptLabel", { name: wt.name })}
                    onClick={() => props.onAdopt?.(wt)}
                  >
                    {t("workspace.found.adopt")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="ws-worktrees">
      <div className="ws-section-head">
        <h2>{t("workspace.heading")}</h2>
        <button
          type="button"
          className="ws-icon-btn"
          aria-label={t("workspace.new")}
          title={t("workspace.new")}
          disabled={props.repos?.every((r) => r.missing) ?? true}
          onClick={() => props.onCreate()}
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="ws-list">
        {props.repos?.length === 0 && <p className="ws-empty">{t("workspace.noRepos")}</p>}
        {sections.length > 0 && <ul className="ws-groups">{sections.map(section)}</ul>}
        {withFound.map(foundGroup)}
        {/* A repo whose folder is gone has no worktrees to list; it stays named so it can be found again. */}
        {gone.length > 0 && (
          <ul className="ws-missing-list">
            {gone.map((repo) => (
              <li key={repo.id} className="ws-missing" title={repo.path}>
                <span className="ws-dot" data-dot="none" aria-hidden="true" />
                <span className="ws-wt-name">{repo.shortName}</span>
                <span className="ws-tag ws-tag-warn" title={t("workspace.missingTitle")}>
                  {t("workspace.missing")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {props.notice && (
        <p className="error-text ws-notice" role="alert">
          {t(`error.${props.notice}`)}
        </p>
      )}
      <div className="ws-sidebar-foot">
        <button type="button" className="ws-add-repo" onClick={() => props.onAddRepo()}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t("workspace.addRepo")}
        </button>
      </div>
    </div>
  );
}

function PinMark(props: { t: T }): JSX.Element {
  return (
    <svg className="ws-pin" role="img" aria-label={props.t("workspace.pinned")} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />
    </svg>
  );
}
