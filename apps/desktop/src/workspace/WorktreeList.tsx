import { useState } from "react";
import type { JSX } from "react";
import type { ApiError, RepoView, WorktreeView } from "../api";
import { useI18n } from "../i18n";
import type { TabStatus } from "./status";

type T = ReturnType<typeof useI18n>["t"];

export interface WorktreeListProps {
  /** Null while the first list is loading. */
  repos: RepoView[] | null;
  selected: string | null;
  /** The status dot of each worktree path; null shows none. */
  dots: Record<string, TabStatus | null>;
  /** Why the last repo or pin action failed. */
  notice?: ApiError["code"];
  onSelect(worktree: WorktreeView): void;
  onCreate(repoId?: string): void;
  onPin(worktree: WorktreeView): void;
  onRemove(worktree: WorktreeView): void;
  onAddRepo(): void;
}

/** The repos of the workspace, each with its worktrees, primary checkout first. */
export function WorktreeList(props: WorktreeListProps): JSX.Element {
  const { t } = useI18n();
  // The worktree whose action menu is open.
  const [menu, setMenu] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const toggle = (id: string) =>
    setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);
  // The primary checkout can be neither pinned nor removed, so it has no menu.
  const openMenu = (wt: WorktreeView) => setMenu(wt.primary ? null : wt.path);
  const pick = (action: () => void) => {
    setMenu(null);
    action();
  };

  // Rows are plain calls, not components, so the list keeps one set of hooks.
  const row = (wt: WorktreeView) => {
    const status = props.dots[wt.path] ?? null;
    const open = menu === wt.path;
    return (
      <li key={wt.path} className="ws-wt" data-path={wt.path}>
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
              <span
                className={status === "working" ? "ws-dot ws-pulse" : "ws-dot"}
                data-dot={status}
                role="img"
                aria-label={t(`workspace.status.${status}`)}
                title={t(`workspace.status.${status}`)}
              />
            ) : (
              <span className="ws-dot" data-dot="none" aria-hidden="true" />
            )}
            <span className="ws-wt-name">{wt.name}</span>
            {wt.pinned && <PinMark t={t} />}
          </span>
          <span className="ws-wt-sub">
            {wt.primary && <span className="ws-tag">{t("workspace.primary")}</span>}
            <span className="ws-wt-branch">{wt.branch ?? t("workspace.detached")}</span>
          </span>
        </button>
        {!wt.primary && (
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
        )}
        {open && (
          <>
            <div className="ws-menu-backdrop" aria-hidden="true" onClick={() => setMenu(null)} />
            <div
              className="ws-menu"
              role="menu"
              aria-label={t("workspace.more", { name: wt.name })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setMenu(null);
              }}
            >
              <button type="button" role="menuitem" autoFocus onClick={() => pick(() => props.onPin(wt))}>
                {wt.pinned ? t("workspace.unpin") : t("workspace.pin")}
              </button>
              <button type="button" role="menuitem" className="ws-menu-danger" onClick={() => pick(() => props.onRemove(wt))}>
                {t("workspace.delete")}
              </button>
            </div>
          </>
        )}
      </li>
    );
  };

  const group = (repo: RepoView) => {
    const open = !collapsed.includes(repo.id);
    return (
      <li key={repo.id} className="ws-group">
        <button
          type="button"
          className="ws-group-head"
          data-repo={repo.id}
          aria-expanded={open}
          title={repo.missing ? t("workspace.missingTitle") : undefined}
          onClick={() => toggle(repo.id)}
        >
          <svg aria-hidden="true" className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span className="ws-group-mark" aria-hidden="true">
            ●
          </span>
          <span className="ws-group-name">{repo.shortName}</span>
          {repo.missing && <span className="ws-tag ws-tag-warn">{t("workspace.missing")}</span>}
          <span className="ws-group-count">{repo.worktrees.length}</span>
        </button>
        {open && <ul className="ws-wts">{repo.worktrees.map(row)}</ul>}
      </li>
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
        {props.repos && props.repos.length > 0 && <ul className="ws-groups">{props.repos.map(group)}</ul>}
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
