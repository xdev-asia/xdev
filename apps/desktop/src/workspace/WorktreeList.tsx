import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { ApiError, Check, FolderEntry, KeptView, OpenInApp, OpenTarget, PrView, PtyProfile, RepoGroup, RepoView, SidebarItem, SidebarPrefs, WorktreeStat, WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import { profileLetter, profileName, useProfiles } from "@/agents/profileStore";
import { ago } from "./ago";
import { groupWorktrees, type Group } from "./groups";
import type { PendingCreate } from "./pendingCreates";
import { checksSummary } from "./ship";
import type { TabStatus } from "./status";
import { StatusGlyph } from "./StatusGlyph";
import { folderMenuItems, groupMenuItems, projectMenuItems, worktreeMenuItems } from "./worktreeMenu";
import { dropMove, flattenRepos, moveTarget, nestRows, pinnedEntries, visibleEntries, type Move, type NestRow, type WtEntry } from "./sidebarModel";
import { RepoBadge } from "./RepoBadge";
import { SidebarFilters } from "./SidebarFilters";
import { WorkItemChip } from "./WorkItemChip";
import { ContextMenu } from "@/ui/ContextMenu";

type T = ReturnType<typeof useI18n>["t"];

type Entry = WtEntry;

/** No filter on: every row shows. */
const NO_FILTERS: SidebarPrefs = { hideDefault: false, hideDetached: false, hideAutomation: false, hideCli: false };

export interface WorktreeListProps {
  /** Told the paths in the order they are drawn, collapsed groups left out; the worktree keys walk it. */
  onOrder?(paths: string[]): void;
  /** Repos, repo groups and plain folders in shown order; null while the first list is loading. */
  items: SidebarItem[] | null;
  /** Which rows the filters hide; none when left out. */
  prefs?: SidebarPrefs;
  /** Without it the header has no filter button. */
  onPrefs?(prefs: SidebarPrefs): void;
  /** A new top-level order of repo, group and folder ids (drag, or Alt+Arrow on a heading). */
  onReorder?(ids: string[]): void;
  /** Moves a repo or folder into a group (or out, with null) at an index. */
  onGroupMove?(member: string, group: string | null, index: number): void;
  onNewGroup?(): void;
  onRenameGroup?(group: RepoGroup): void;
  onRemoveGroup?(group: RepoGroup): void;
  /** Lists a plain folder; without it the footer has no such button. */
  onAddFolder?(): void;
  /** A click on a plain folder: a terminal tab opens there. */
  onOpenFolder?(folder: FolderEntry): void;
  onForgetFolder?(folder: FolderEntry): void;
  /** Brings an archived worktree back. */
  onRestore?(repoId: string, branch: string): void;
  /** Opens the review of the branches a repo kept. */
  onReviewBranches?(repoId: string): void;
  onEditDetails?(worktree: WorktreeView): void;
  onRenameBranch?(worktree: WorktreeView): void;
  onArchive?(worktree: WorktreeView): void;
  /** A click on a work item chip: the shell copies the URL. */
  onCopyLink?(url: string): void;
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
  /** Worktree paths in the multi-selection. */
  picked?: ReadonlySet<string>;
  /** Ctrl/Cmd or Shift click: change the selection instead of opening the worktree. */
  onPick?(worktree: WorktreeView, mods: { toggle: boolean; range: boolean }): void;
  onSelectAll?(): void;
  onClearPicked?(): void;
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
  /** The Open In apps, in order; the Open in menu lists them above File Manager. */
  openInApps?: OpenInApp[];
  /** Opens a worktree or repo folder in an app or the file manager. */
  onOpenIn?(path: string, target: OpenTarget): void;
  /** Writes text to the clipboard (Copy Path, Copy Worktree Name, Copy Branch). */
  onCopy?(text: string): void;
  /** Opens a shell tab in the worktree; without it the Open in menu has no such item. */
  onNewTerminal?(worktree: WorktreeView): void;
  /** Opens Settings › Repos for the repo. */
  onRepoSettings?(repo: RepoView): void;
  /** Asks to forget the repo in xDev; without it the project menu has no Remove item. */
  onRemoveRepo?(repo: RepoView): void;
  /** Creates running in the background, or failed; each shows a row above the list. */
  pending?: PendingCreate[];
  onCancelCreate?(id: string): void;
  onRetryCreate?(id: string): void;
  onDismissCreate?(id: string): void;
}

/** The open menu: a worktree row or a repo, and where it opened. */
type OpenMenu = { kind: "worktree" | "repo" | "folder" | "group"; key: string; at: { x: number; y: number } };

/** The corner under a button, where its menu opens. */
function below(el: HTMLElement): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}

/** The worktrees of every repo, split into sections by what their agents are doing. */
export function WorktreeList(props: WorktreeListProps): JSX.Element {
  const { t } = useI18n();
  const { view } = useProfiles();
  // The worktree or repo whose menu is open.
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [collapsed, setCollapsed] = useState<Group[]>([]);
  // Parent worktree paths whose children are folded away; project groups and "Archived" lists folded.
  const [folded, setFolded] = useState<string[]>([]);
  const [shut, setShut] = useState<string[]>([]);
  const [archivedOpen, setArchivedOpen] = useState<string[]>([]);
  // The Pinned group is folded.
  const [pinnedShut, setPinnedShut] = useState(false);
  // The id being dragged in the project list.
  const [dragging, setDragging] = useState<string | null>(null);
  const prefs = props.prefs ?? NO_FILTERS;
  const tree = props.items;
  // The repos whose "Found outside xDev" group is open; all start closed.
  const [foundOpen, setFoundOpen] = useState<string[]>([]);

  const toggle = (group: Group) =>
    setCollapsed(collapsed.includes(group) ? collapsed.filter((c) => c !== group) : [...collapsed, group]);
  const apps = props.openInApps ?? [];
  const copy = (text: string) => props.onCopy?.(text);

  // Rows are plain calls, not components, so the list keeps one set of hooks.
  // `pinnedGroup`: the row sits in the Pinned group, which names the project on every row.
  const row = ({ entry: { wt, repo }, depth, children }: NestRow, pinnedGroup: boolean) => {
    const status = props.dots[wt.path] ?? null;
    const open = menu?.kind === "worktree" && menu.key === wt.path;
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
      <li key={wt.path} className={(unread ? "ws-wt ws-wt-unread" : "ws-wt") + (depth === 2 ? " ws-wt-child" : "")} data-path={wt.path} data-depth={depth} data-picked={props.picked?.has(wt.path) ? "true" : undefined}>
        <button
          type="button"
          className="ws-wt-main"
          title={wt.path}
          aria-current={props.selected === wt.path ? "true" : undefined}
          onClick={(e) => {
            const toggle = e?.ctrlKey === true || e?.metaKey === true;
            if (props.onPick && !wt.primary && (toggle || e?.shiftKey === true)) props.onPick(wt, { toggle, range: e.shiftKey });
            else props.onSelect(wt);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ kind: "worktree", key: wt.path, at: { x: e.clientX, y: e.clientY } });
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
            <span className="ws-wt-name" title={wt.title ?? wt.name}>
              {wt.title ?? wt.name}
            </span>
            {wt.pinned && <PinMark t={t} />}
            {seen !== null && <span className="ws-wt-time">{ago(seen, props.now ?? Date.now(), t)}</span>}
          </span>
          <span className="ws-wt-sub">
            {wt.primary && <span className="ws-tag">{t("workspace.primary")}</span>}
            {(many || pinnedGroup) && (
              <span className="ws-tag ws-tag-project" data-project-chip={repo.id}>
                <RepoBadge repo={repo} />
                {repo.shortName}
              </span>
            )}
            <span className="ws-wt-branch" title={wt.branch ?? undefined}>
              {wt.branch ?? t("workspace.detached")}
            </span>
          </span>
          {wt.comment.trim() !== "" && (
            <span
              className="ws-wt-comment"
              title={wt.comment}
              onDoubleClick={(e) => {
                e.stopPropagation();
                props.onEditDetails?.(wt);
              }}
            >
              {wt.comment.split("\n")[0]}
            </span>
          )}
          {(agents.length > 0 || counts || pr || wt.status || wt.item || wt.setByCliMs != null) && (
            <span className="ws-wt-meta">
              {wt.status && (
                <span className="ws-chip ws-wt-status" data-work={wt.status}>
                  {t(`workspace.work.${wt.status}`)}
                </span>
              )}
              {wt.setByCliMs != null && (
                <span className="ws-wt-cli" title={t("cli.mark.title", { ago: ago(wt.setByCliMs, props.now ?? Date.now(), t) })}>
                  {t("cli.mark")}
                </span>
              )}
              {wt.item && props.onCopyLink && <WorkItemChip item={wt.item} onCopy={props.onCopyLink} />}
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
          onClick={(e) => setMenu({ kind: "worktree", key: wt.path, at: below(e.currentTarget) })}
        >
          ⋯
        </button>
        {children > 0 && (
          <button
            type="button"
            className="ws-wt-kids"
            aria-expanded={!folded.includes(wt.path)}
            aria-label={t("workspace.children.label", { name: wt.title ?? wt.name, count: children })}
            onClick={() => setFolded(folded.includes(wt.path) ? folded.filter((p) => p !== wt.path) : [...folded, wt.path])}
          >
            {t("workspace.children", { count: children })}
          </button>
        )}
      </li>
    );
  };

  const repoList = flattenRepos(tree ?? []);
  const entries: Entry[] = repoList.flatMap((repo) => repo.worktrees.map((wt) => ({ path: wt.path, wt, repo })));
  // The repo is named on a row only when more than one repo is listed.
  const many = repoList.length > 1;
  const shown = visibleEntries(entries, prefs, props.selected);
  // Pinned worktrees get their own group first and are left out of the status sections.
  const shownPaths = new Set(shown.entries.map((e) => e.path));
  const pinnedRows = nestRows(pinnedEntries(tree ?? []).filter((e) => shownPaths.has(e.path)), new Set(folded));
  const pinnedPaths = new Set(pinnedRows.map((r) => r.entry.path));
  const sections = groupWorktrees(
    shown.entries.filter((e) => !pinnedPaths.has(e.path)),
    (path) => props.dots[path] ?? null,
  ).map((s) => ({ group: s.group, items: nestRows(s.items, new Set(folded)) }));
  const gone = repoList.filter((repo) => repo.missing);
  const order = [
    ...(pinnedShut ? [] : pinnedRows.map((r) => r.entry.path)),
    ...sections.filter((s) => !collapsed.includes(s.group)).flatMap((s) => s.items.map((r) => r.entry.path)),
  ];
  const { onOrder } = props;
  useEffect(() => onOrder?.(order), [order.join(",")]);

  const section = ({ group, items }: { group: Group; items: NestRow[] }) => {
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
        {open && <ul className="ws-wts">{items.map((r) => row(r, false))}</ul>}
      </li>
    );
  };

  const pinnedSection = () => (
    <li key="pinned" className="ws-group ws-group-pinned" data-group="pinned">
      <button type="button" className="ws-group-head" data-group="pinned" aria-expanded={!pinnedShut} onClick={() => setPinnedShut(!pinnedShut)}>
        <svg aria-hidden="true" className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
        <svg className="ws-pin" aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />
        </svg>
        <span className="ws-group-name">{t("sidebar.pinned.title")}</span>
        <span className="ws-group-count">{pinnedRows.length}</span>
      </button>
      {!pinnedShut && <ul className="ws-wts">{pinnedRows.map((r) => row(r, true))}</ul>}
    </li>
  );

  // A create still running: name, spinner, Cancel. One that failed: why, Retry and Dismiss.
  const pendingRow = (job: PendingCreate) => (
    <li key={job.id} className="ws-wt ws-wt-pending" data-pending={job.id} data-state={job.state}>
      <span className="ws-pending-text">
        <span className="ws-pending-line">
          {job.state === "running" ? (
            <span className="ws-glyph" data-status="working" role="progressbar" aria-label={t("workspace.pending.creating", { name: job.name })} title={t("workspace.pending.creating", { name: job.name })} />
          ) : (
            <span className="ws-glyph" data-status="failed" aria-hidden="true" />
          )}
          <span className="ws-wt-name" title={job.name}>
            {job.name}
          </span>
        </span>
        {job.state === "failed" && (
          <span className="ws-pending-error" role="alert" title={job.error ? t(`error.${job.error.code}`) : undefined}>
            {t("workspace.pending.failed")}
            {job.error && ` · ${t(`error.${job.error.code}`)}`}
          </span>
        )}
      </span>
      {job.state === "running" ? (
        <button type="button" className="btn-secondary ws-pending-btn" aria-label={t("workspace.pending.cancelLabel", { name: job.name })} onClick={() => props.onCancelCreate?.(job.id)}>
          {t("workspace.pending.cancel")}
        </button>
      ) : (
        <>
          <button type="button" className="btn-secondary ws-pending-btn" aria-label={t("workspace.pending.retryLabel", { name: job.name })} onClick={() => props.onRetryCreate?.(job.id)}>
            {t("workspace.pending.retry")}
          </button>
          <button type="button" className="btn-secondary ws-pending-btn" aria-label={t("workspace.pending.dismissLabel", { name: job.name })} onClick={() => props.onDismissCreate?.(job.id)}>
            {t("workspace.pending.dismiss")}
          </button>
        </>
      )}
    </li>
  );
  const pending = props.pending ?? [];

  const withFound = repoList.filter((repo) => !repo.missing && repo.found.length > 0);
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

  const moreButton = (kind: "repo" | "folder" | "group", id: string, name: string) => (
    <button
      type="button"
      className="ws-wt-more ws-repo-more"
      aria-label={t(kind === "group" ? "group.more" : kind === "folder" ? "folder.more" : "project.more", { name })}
      title={t(kind === "group" ? "group.more" : kind === "folder" ? "folder.more" : "project.more", { name })}
      aria-haspopup="menu"
      aria-expanded={menu?.kind === kind && menu.key === id}
      onClick={(e) => setMenu({ kind, key: id, at: below(e.currentTarget) })}
    >
      ⋯
    </button>
  );
  const projectMore = (repo: RepoView) => moreButton("repo", repo.id, repo.shortName);
  const menuAt = (kind: "repo" | "folder" | "group", id: string) => (e: { preventDefault(): void; clientX: number; clientY: number }) => {
    e.preventDefault();
    setMenu({ kind, key: id, at: { x: e.clientX, y: e.clientY } });
  };
  const projectMenu = (repo: RepoView) => menuAt("repo", repo.id);

  const groups = (tree ?? []).flatMap((i) => (i.kind === "group" ? [i.group] : []));
  const groupOfMember = (id: string) => groups.find((g) => g.members.includes(id))?.id ?? null;
  const keptOf = (repoId: string): KeptView[] => {
    for (const i of tree ?? []) {
      if (i.kind === "repo" && i.repo.id === repoId) return i.kept;
      if (i.kind === "group") for (const m of i.items) if (m.kind === "repo" && m.repo.id === repoId) return m.kept;
    }
    return [];
  };
  const folderOf = (id: string): FolderEntry | undefined => {
    for (const i of tree ?? []) {
      if (i.kind === "folder" && i.folder.id === id) return i.folder;
      if (i.kind === "group") for (const m of i.items) if (m.kind === "folder" && m.folder.id === id) return m.folder;
    }
    return undefined;
  };

  const apply = (move: Move | null) => {
    if (!move) return;
    if ("order" in move) props.onReorder?.(move.order);
    else props.onGroupMove?.(move.member, move.group, move.index);
  };
  // Drag and Alt+Arrow on a heading reorder repos, folders and groups.
  const reorder = (id: string) => ({
    draggable: props.onReorder !== undefined || props.onGroupMove !== undefined,
    onDragStart: (e: { dataTransfer?: { setData?(type: string, value: string): void }; stopPropagation?(): void }) => {
      e.stopPropagation?.();
      e.dataTransfer?.setData?.("text/plain", id);
      setDragging(id);
    },
    onDragEnd: () => setDragging(null),
    onDragOver: (e: { preventDefault(): void }) => {
      if (dragging && dropMove(tree ?? [], dragging, id)) e.preventDefault();
    },
    onDrop: (e: { preventDefault(): void; stopPropagation?(): void }) => {
      e.preventDefault();
      e.stopPropagation?.();
      const from = dragging;
      setDragging(null);
      if (from) apply(dropMove(tree ?? [], from, id));
    },
    onKeyDown: (e: { key: string; altKey: boolean; target: unknown; currentTarget: unknown; preventDefault(): void }) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.target !== e.currentTarget) return;
      e.preventDefault();
      apply(moveTarget(tree ?? [], id, e.key === "ArrowUp" ? -1 : 1));
    },
  });

  const archivedBlock = (repo: RepoView, kept: KeptView[]): JSX.Element[] => {
    const recent = kept.filter((k) => k.archivedShown);
    if (recent.length === 0) return [];
    const open = archivedOpen.includes(repo.id);
    return [
      <li key={`${repo.id}:archived`} className="ws-archived" data-repo={repo.id}>
        <button
          type="button"
          className="ws-group-head ws-archived-head"
          aria-expanded={open}
          onClick={() => setArchivedOpen(open ? archivedOpen.filter((id) => id !== repo.id) : [...archivedOpen, repo.id])}
        >
          <svg aria-hidden="true" className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span className="ws-group-name">{t("archived.title", { count: recent.length })}</span>
        </button>
        {open && (
          <ul className="ws-found-list">
            {recent.map(({ entry }) => (
              <li key={entry.branch} className="ws-found-row" title={entry.path}>
                <span className="ws-found-text">
                  <span className="ws-wt-name">{entry.title ?? entry.branch}</span>
                  <span className="ws-wt-branch">{ago(entry.keptMs, props.now ?? Date.now(), t)}</span>
                </span>
                {props.onRestore && (
                  <button type="button" className="btn-secondary ws-found-adopt" aria-label={t("archived.restoreLabel", { name: entry.title ?? entry.branch })} onClick={() => props.onRestore?.(repo.id, entry.branch)}>
                    {t("archived.restore")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </li>,
    ];
  };

  // One entry of the project list: a repo with its archived list, a plain folder, or a group with its members.
  const projectItem = (item: SidebarItem): JSX.Element[] => {
    if (item.kind === "repo") {
      const { repo, kept } = item;
      if (repo.missing) return [];
      return [
        <li key={repo.id} className="ws-repo" data-repo={repo.id} title={repo.path} tabIndex={0} data-dragging={dragging === repo.id ? "true" : undefined} onContextMenu={projectMenu(repo)} {...reorder(repo.id)}>
          <RepoBadge repo={repo} />
          <span className="ws-repo-name">{repo.shortName}</span>
          {projectMore(repo)}
        </li>,
        ...archivedBlock(repo, kept),
      ];
    }
    if (item.kind === "folder") {
      const { folder } = item;
      return [
        <li key={folder.id} className="ws-repo ws-folder" data-folder={folder.id} title={folder.path} tabIndex={0} data-dragging={dragging === folder.id ? "true" : undefined} onContextMenu={menuAt("folder", folder.id)} {...reorder(folder.id)}>
          <button type="button" className="ws-folder-main" onClick={() => props.onOpenFolder?.(folder)}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h6l2 2h10v10H3z" />
            </svg>
            <span className="ws-repo-name">{folder.name}</span>
          </button>
          {moreButton("folder", folder.id, folder.name)}
        </li>,
      ];
    }
    const { group } = item;
    const open = !shut.includes(group.id);
    return [
      <li key={group.id} className="ws-project-group" data-project-group={group.id}>
        <div className="ws-repo ws-group-row" tabIndex={0} data-dragging={dragging === group.id ? "true" : undefined} onContextMenu={menuAt("group", group.id)} {...reorder(group.id)}>
          <button type="button" className="ws-group-head ws-project-head" aria-expanded={open} onClick={() => setShut(open ? [...shut, group.id] : shut.filter((id) => id !== group.id))}>
            <svg aria-hidden="true" className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
            <span className="ws-group-name">{group.name}</span>
            <span className="ws-group-count">{group.members.length}</span>
          </button>
          {moreButton("group", group.id, group.name)}
        </div>
        {open && <ul className="ws-repos ws-repos-nested">{item.items.flatMap(projectItem)}</ul>}
      </li>,
    ];
  };
  const hasProjects = (tree ?? []).some((i) => i.kind !== "repo" || !i.repo.missing);

  // The menu of the open row or repo; null when what it was opened on has gone from the list.
  const openMenuNode = () => {
    if (!menu) return null;
    let items;
    const groupMenu = (id: string) => ({
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      groupId: groupOfMember(id),
      moveToGroup: props.onGroupMove && ((group: string | null) => props.onGroupMove?.(id, group, group === null ? (tree ?? []).length : 0)),
      newGroup: props.onNewGroup,
    });
    if (menu.kind === "worktree") {
      const wt = entries.find((e) => e.path === menu.key)?.wt;
      if (!wt) return null;
      items = worktreeMenuItems({
        worktree: wt,
        apps,
        unread: props.unread?.[wt.path] === true,
        openIn: (target) => props.onOpenIn?.(wt.path, target),
        copy,
        newTerminal: props.onNewTerminal && (() => props.onNewTerminal?.(wt)),
        onPin: () => props.onPin(wt),
        onMarkUnread: props.onMarkUnread && (() => props.onMarkUnread?.(wt)),
        onMarkRead: props.onMarkRead && (() => props.onMarkRead?.(wt)),
        onRemove: () => props.onRemove(wt),
        onEditDetails: props.onEditDetails && (() => props.onEditDetails?.(wt)),
        onRenameBranch: props.onRenameBranch && (() => props.onRenameBranch?.(wt)),
        onArchive: props.onArchive && (() => props.onArchive?.(wt)),
      });
    } else if (menu.kind === "folder") {
      const folder = folderOf(menu.key);
      if (!folder) return null;
      items = folderMenuItems({
        path: folder.path,
        copy,
        forget: () => props.onForgetFolder?.(folder),
        newTerminal: props.onOpenFolder && (() => props.onOpenFolder?.(folder)),
        ...groupMenu(folder.id),
      });
    } else if (menu.kind === "group") {
      const group = groups.find((g) => g.id === menu.key);
      if (!group) return null;
      items = groupMenuItems({ rename: () => props.onRenameGroup?.(group), remove: () => props.onRemoveGroup?.(group) });
    } else {
      const repo = repoList.find((r) => r.id === menu.key);
      if (!repo) return null;
      const kept = keptOf(repo.id);
      items = projectMenuItems({
        path: repo.path,
        apps,
        openIn: (target) => props.onOpenIn?.(repo.path, target),
        copy,
        repoSettings: () => props.onRepoSettings?.(repo),
        remove: () => props.onRemoveRepo?.(repo),
        review: kept.length > 0 && props.onReviewBranches ? { label: t("project.review", { count: kept.length }), run: () => props.onReviewBranches?.(repo.id) } : null,
        ...groupMenu(repo.id),
      });
    }
    return <ContextMenu key={`${menu.kind}:${menu.key}`} at={menu.at} items={items} onClose={() => setMenu(null)} />;
  };

  return (
    <div
      className="ws-worktrees"
      onKeyDown={(e) => {
        const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
        if (typing) return;
        if (e.key === "Escape" && (props.picked?.size ?? 0) > 0) props.onClearPicked?.();
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && props.onSelectAll) {
          e.preventDefault();
          props.onSelectAll();
        }
      }}
    >
      <div className="ws-section-head">
        <h2>{t("workspace.heading")}</h2>
        {props.onPrefs && <SidebarFilters prefs={prefs} hidden={shown.hidden} onPrefs={props.onPrefs} />}
        <button
          type="button"
          className="ws-icon-btn"
          aria-label={t("workspace.new")}
          title={t("workspace.new")}
          disabled={repoList.every((r) => r.missing)}
          onClick={() => props.onCreate()}
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="ws-list">
        {tree?.length === 0 && <p className="ws-empty">{t("workspace.noRepos")}</p>}
        {pending.length > 0 && (
          <ul className="ws-wts ws-pending" aria-label={t("workspace.pending.heading")}>
            {pending.map(pendingRow)}
          </ul>
        )}
        {(sections.length > 0 || pinnedRows.length > 0) && (
          <ul className="ws-groups">
            {pinnedRows.length > 0 && pinnedSection()}
            {sections.map(section)}
          </ul>
        )}
        {hasProjects && (
          <ul className="ws-repos" aria-label={t("project.heading")}>
            {(tree ?? []).flatMap(projectItem)}
          </ul>
        )}
        {withFound.map(foundGroup)}
        {/* A repo whose folder is gone has no worktrees to list; it stays named so it can be found again. */}
        {gone.length > 0 && (
          <ul className="ws-missing-list">
            {gone.map((repo) => (
              <li key={repo.id} className="ws-missing" title={repo.path} onContextMenu={projectMenu(repo)}>
                <span className="ws-dot" data-dot="none" aria-hidden="true" />
                <span className="ws-wt-name">{repo.shortName}</span>
                <span className="ws-tag ws-tag-warn" title={t("workspace.missingTitle")}>
                  {t("workspace.missing")}
                </span>
                {projectMore(repo)}
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
      {openMenuNode()}
      <div className="ws-sidebar-foot">
        <button type="button" className="ws-add-repo" onClick={() => props.onAddRepo()}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t("workspace.addRepo")}
        </button>
        {props.onAddFolder && (
          <button type="button" className="ws-add-repo" onClick={() => props.onAddFolder?.()}>
            {t("folder.add")}
          </button>
        )}
        {props.onNewGroup && (
          <button type="button" className="ws-add-repo" onClick={() => props.onNewGroup?.()}>
            {t("group.new")}
          </button>
        )}
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
