import { useEffect, useState } from "react";
import { Badge, Button } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { ApiError, Check, FolderEntry, KeptView, OpenInApp, OpenTarget, PrView, PtyProfile, RepoGroup, RepoView, SidebarItem, SidebarPrefs, WorkStatus, WorktreeStat, WorktreeView } from "@/api";
import { SIDEBAR_PREFS_DEFAULTS } from "@/mockSettings";
import { useI18n } from "@/i18n";
import { profileLetter, profileName, useProfiles } from "@/agents/profileStore";
import { ago } from "./ago";
import { cardParts } from "./cardModel";
import { groupBy, orderedWorktrees, type Section } from "./groups";
import { orderItems } from "./projectOrder";
import { recentSnapshot, sortEntries, type RecentSnapshot } from "./sidebarSort";
import type { PendingCreate } from "./pendingCreates";
import { checksSummary } from "./ship";
import type { TabStatus } from "./status";
import { StatusGlyph } from "./StatusGlyph";
import { childrenOf, parentCandidates, parentOf } from "./lineage";
import { folderMenuItems, groupMenuItems, projectMenuItems, worktreeMenuItems } from "./worktreeMenu";
import { activeProjects, dropMove, flattenRepos, moveTarget, nestRows, pinnedEntries, projectListRepeatsCards, repeatedRepos, sectionHeadless, visibleEntries, type Move, type NestRow, type WtEntry } from "./sidebarModel";
import { RepoBadge } from "./RepoBadge";
import { useKeymap } from "@/keys/keymap";
import { SidebarFilters } from "./SidebarFilters";
import { VisibilityDialog } from "./VisibilityDialog";
import { acknowledgeNew, isWorktreeVisible, newExternal, restoreAll, setWorktreeShown, visibilityRows } from "./worktreeVisibility";
import { SidebarOptions } from "./SidebarOptions";
import { WorkItemChip } from "./WorkItemChip";
import { PortsChip, PortsPopover } from "./PortsChip";
import type { LivePort } from "./livePorts";
import { ContextMenu } from "@/ui/ContextMenu";
import { SetupGuideEntry } from "@/onboarding/SetupGuideEntry";

type T = ReturnType<typeof useI18n>["t"];

type Entry = WtEntry;


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
  /** Opens the board of worktrees by work status; without it the header has no board button. */
  onOpenBoard?(): void;
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
  /** Opens the parent picker; without it the menu has no lineage items. */
  onSetParent?(worktree: WorktreeView): void;
  /** Clears a worktree's parent. */
  onRemoveParent?(worktree: WorktreeView): void;
  /** Opens the delete dialog with the nested worktrees ticked. */
  onDeleteNested?(worktree: WorktreeView): void;
  /** Sets the work status (null clears it); without it the menu has no Move to status. */
  onMoveStatus?(worktree: WorktreeView, status: WorkStatus | null): void;
  onRenameBranch?(worktree: WorktreeView): void;
  onCheckoutBranch?(worktree: WorktreeView): void;
  onArchive?(worktree: WorktreeView): void;
  /** A click on a work item chip: the shell copies the URL. */
  onCopyLink?(url: string): void;
  /** The live ports of each worktree path; a path with none shows no chip. */
  ports?: Record<string, LivePort[] | undefined>;
  /** Browser, copy and stop for a port; the stop resolves once the process is gone. */
  onOpenPort?(port: LivePort): void;
  onCopyPort?(port: LivePort): void;
  onStopPort?(worktree: WorktreeView, port: LivePort): Promise<void>;
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
  /** A click on the PR chip: the row is selected as for any click, then this opens the pull request panel. */
  onOpenPr?(): void;
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
  /** Worktree paths whose tabs are all asleep; the row says so and its menu offers Wake. */
  asleep?: Record<string, boolean>;
  /** Worktree paths with no awake tab (false); the menu leaves Sleep out for them. A path not listed is sleepable. */
  sleepable?: Record<string, boolean>;
  /** Puts a worktree's tabs to sleep; without it the menu has no such item. */
  onSleep?(worktree: WorktreeView): void;
  /** Puts a worktree and its nested worktrees to sleep; without it the menu has no such item. */
  onSleepNested?(worktree: WorktreeView): void;
  /** Wakes a sleeping worktree's tabs. */
  onWake?(worktree: WorktreeView): void;
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
  // Folded sections, by their mode-scoped key.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Parent worktree paths whose children are folded away; project groups and "Archived" lists folded.
  const [folded, setFolded] = useState<string[]>([]);
  const [shut, setShut] = useState<string[]>([]);
  const [archivedOpen, setArchivedOpen] = useState<string[]>([]);
  // The Pinned group is folded.
  const [pinnedShut, setPinnedShut] = useState(false);
  // The id being dragged in the project list.
  const [dragging, setDragging] = useState<string | null>(null);
  // The worktree whose live ports popover is open, where it opens, and the pid whose Stop asks again.
  const [portsOpen, setPortsOpen] = useState<{ worktree: WorktreeView; at: { x: number; y: number } } | null>(null);
  const [stopAsk, setStopAsk] = useState<{ pid: number; since: number } | null>(null);
  const prefs = props.prefs ?? SIDEBAR_PREFS_DEFAULTS;
  const tree = props.items;
  // The Sleeping only filter lasts for the session; it is not one of the saved sidebar preferences.
  const [sleepingOnly, setSleepingOnly] = useState(false);
  // The visibility dialog (outside and hidden worktrees) is open.
  const [visOpen, setVisOpen] = useState(false);
  useKeymap({
    "sidebar.sleepingOnly.toggle": () => setSleepingOnly((on) => !on),
    "sidebar.visibility.open": () => props.onPrefs && setVisOpen(true),
  });
  // The repos whose "Found outside xDev" group is open; all start closed.
  const [foundOpen, setFoundOpen] = useState<string[]>([]);
  // The activity times the recent order was taken from, and how often the window has regained focus.
  const [recent, setRecent] = useState<RecentSnapshot | null>(null);
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocus((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const toggle = (key: string) =>
    setCollapsed(collapsed.includes(key) ? collapsed.filter((c) => c !== key) : [...collapsed, key]);
  const apps = props.openInApps ?? [];
  const copy = (text: string) => props.onCopy?.(text);

  // Rows are plain calls, not components, so the list keeps one set of hooks.
  // `pinnedGroup`: the row sits in the Pinned group, which names the project on every row.
  const parts = cardParts(prefs);
  const compact = prefs.compactCards;
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
    const statNode = counts && parts.has("diffStat") && (
      <span className="ws-stat" title={t("workspace.row.stat", counts)}>
        <span className="ws-stat-add">{`+${counts.added}`}</span>{" "}
        <span className="ws-stat-del">{`−${counts.removed}`}</span>
      </span>
    );
    const prNode = pr && parts.has("pr") && (
      <span
        className="ws-pr"
        role="img"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          props.onOpenPr?.();
        }}
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
    );
    const livePorts = parts.has("ports") ? (props.ports?.[wt.path] ?? []) : [];
    const portsNode = livePorts.length > 0 && props.onStopPort && <PortsChip count={livePorts.length} onOpen={(at) => setPortsOpen({ worktree: wt, at })} />;
    const showAgents = parts.has("agents") ? agents : [];
    const showStatus = parts.has("workStatus") ? wt.status : null;
    const showItem = parts.has("workItem") ? wt.item : null;
    const showCli = parts.has("workStatus") ? wt.setByCliMs : null;
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
            {props.asleep?.[wt.path] === true && <Badge>{t("sleep.badge")}</Badge>}
            {seen !== null && parts.has("time") && <span className="ws-wt-time">{ago(seen, props.now ?? Date.now(), t)}</span>}
            {compact && statNode}
            {compact && prNode}
            {compact && portsNode}
          </span>
          {!compact && (parts.has("branch") || parts.has("projectChip") || wt.primary) && (
          <span className="ws-wt-sub">
            {wt.primary && <span className="ws-tag">{t("workspace.primary")}</span>}
            {(many || pinnedGroup) && parts.has("projectChip") && (
              <span className="ws-tag ws-tag-project" data-project-chip={repo.id}>
                <RepoBadge repo={repo} />
                {repo.shortName}
              </span>
            )}
            {parts.has("branch") && (
              <span className="ws-wt-branch" title={wt.branch ?? undefined}>
                {wt.branch ?? t("workspace.detached")}
              </span>
            )}
          </span>
          )}
          {!compact && parts.has("comment") && wt.comment.trim() !== "" && (
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
          {!compact && (showAgents.length > 0 || statNode || prNode || portsNode || showStatus || showItem || showCli != null) && (
            <span className="ws-wt-meta">
              {showStatus && (
                <span className="ws-chip ws-wt-status" data-work={showStatus}>
                  {t(`workspace.work.${showStatus}`)}
                </span>
              )}
              {showCli != null && (
                <span className="ws-wt-cli" title={t("cli.mark.title", { ago: ago(showCli, props.now ?? Date.now(), t) })}>
                  {t("cli.mark")}
                </span>
              )}
              {showItem && props.onCopyLink && <WorkItemChip item={showItem} onCopy={props.onCopyLink} />}
              {showAgents.map((p) => (
                <span key={p} className="ws-chip" data-profile={p} title={profileName(view, p, t)}>
                  {profileLetter(view, p)}
                </span>
              ))}
              <span className="ws-wt-spacer" />
              {portsNode}
              {statNode}
              {prNode}
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
  const manualEntries: Entry[] = repoList.flatMap((repo) => repo.worktrees.map((wt) => ({ path: wt.path, wt, repo })));
  // The recent order is a snapshot: retaken when the sort, the project order, the set of worktrees or the window focus changes.
  const snapshot = recentSnapshot(recent, { sort: prefs.sort, projectOrder: prefs.projectOrder, paths: manualEntries.map((e) => e.path), activity: props.activity, focus });
  if (snapshot !== recent) setRecent(snapshot);
  // Recent project order: repo headings and project sections follow the newest output; dragging is off.
  const projectsByRecent = prefs.projectOrder === "recent";
  const drawnTree = projectsByRecent ? orderItems(tree ?? [], snapshot.activity) : (tree ?? []);
  const entries: Entry[] = projectsByRecent ? flattenRepos(drawnTree).flatMap((repo) => repo.worktrees.map((wt) => ({ path: wt.path, wt, repo }))) : manualEntries;
  const sortRows = <T extends { path: string }>(list: readonly T[]): T[] => sortEntries(list, prefs.sort, snapshot.activity, (path) => props.dots[path]);
  // The repo is named on a row only when more than one repo is listed.
  const many = repoList.length > 1;
  const shown = visibleEntries(entries, prefs, props.selected, { only: sleepingOnly, asleep: props.asleep ?? {} }, repoList.map((r) => r.id));
  // Pinned worktrees get their own group first and are left out of the status sections.
  const shownPaths = new Set(shown.entries.map((e) => e.path));
  const pinnedRows = nestRows(sortRows(pinnedEntries(tree ?? []).filter((e) => shownPaths.has(e.path))), new Set(folded));
  const pinnedPaths = new Set(pinnedRows.map((r) => r.entry.path));
  // Sections come from the rows in sidebar order, so a sort never reorders the sections; it sorts inside each.
  const sections = groupBy(
    shown.entries.filter((e) => prefs.pinnedInGroups || !pinnedPaths.has(e.path)),
    prefs.groupBy,
    { dotOf: (path) => props.dots[path] ?? null, prOf: (path) => props.prs?.[path]?.pr?.state ?? null },
  ).map((s): Section<NestRow> => ({ ...s, items: nestRows(sortRows(s.items), new Set(folded)) }));
  const gone = repoList.filter((repo) => repo.missing);
  // A pinned row drawn twice (Pinned in groups) is listed once, at its first place.
  const order = [
    ...new Set([
      ...(pinnedShut ? [] : pinnedRows.map((r) => r.entry.path)),
      ...orderedWorktrees(sections.map((s) => ({ key: s.key, items: s.items.map((r) => ({ path: r.entry.path })) })), collapsed),
    ]),
  ];
  const { onOrder } = props;
  useEffect(() => onOrder?.(order), [order.join(",")]);

  const sectionName = (s: Section<NestRow>): string => {
    if (s.mode === "activity") return t(`workspace.group.${s.id}`);
    if (s.mode === "project") return s.repo?.shortName ?? s.id;
    if (s.mode === "status") return s.id === "none" ? t("workspace.groupBy.status.none") : t(`workspace.work.${s.id}`);
    return t(`workspace.groupBy.pr.${s.id}`);
  };

  const section = (s: Section<NestRow>) => {
    // No grouping: the rows stand alone, without a heading.
    if (s.mode === "none" || sectionHeadless(s, sections.length, pinnedRows.length)) {
      return (
        <li key={s.key} className="ws-group ws-group-bare" data-group={s.mode === "none" ? "none" : s.key}>
          <ul className="ws-wts">{s.items.map((r) => row(r, false))}</ul>
        </li>
      );
    }
    const open = !collapsed.includes(s.key);
    const dataGroup = s.mode === "activity" ? s.id : s.key;
    return (
      <li key={s.key} className="ws-group" data-group={dataGroup}>
        <button type="button" className="ws-group-head" data-group={dataGroup} aria-expanded={open} onClick={() => toggle(s.key)}>
          <svg aria-hidden="true" className="ws-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
          {s.mode === "activity" && <span className={s.id === "working" ? "ws-group-dot ws-pulse" : "ws-group-dot"} data-group={s.id} aria-hidden="true" />}
          {s.mode === "pr" && s.id !== "none" && <span className="ws-dot" data-pr={s.id} aria-hidden="true" />}
          {s.mode === "project" && s.repo && <RepoBadge repo={s.repo} />}
          <span className="ws-group-name">{sectionName(s)}</span>
          <span className="ws-group-count">{s.items.length}</span>
        </button>
        {open && <ul className="ws-wts">{s.items.map((r) => row(r, false))}</ul>}
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

  // Outside worktrees the person has not hidden, of the projects the filter keeps.
  const projectKept = activeProjects(prefs.projectFilter, repoList.map((r) => r.id));
  const foundOf = (repo: RepoView) => (projectKept && !projectKept.has(repo.id) ? [] : repo.found.filter((wt) => isWorktreeVisible(wt, true, prefs)));
  const withFound = repoList.filter((repo) => !repo.missing && foundOf(repo).length > 0);
  const freshExternal = newExternal(repoList.flatMap((repo) => repo.found.map((wt) => wt.path)), prefs);
  const foundGroup = (repo: RepoView) => {
    const open = foundOpen.includes(repo.id);
    const found = foundOf(repo);
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
          <span className="ws-group-name">{t("workspace.found.title", { count: found.length })}</span>
          {many && <span className="ws-tag">{repo.shortName}</span>}
        </button>
        {open && (
          <ul className="ws-found-list">
            {found.map((wt) => (
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
    draggable: !projectsByRecent && (props.onReorder !== undefined || props.onGroupMove !== undefined),
    onDragStart: (e: { dataTransfer?: { setData?(type: string, value: string): void }; stopPropagation?(): void }) => {
      if (projectsByRecent) return;
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
      if (projectsByRecent || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.target !== e.currentTarget) return;
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
  // Repos whose project row would only repeat their cards; their menu rides on the card instead.
  const repeated = repeatedRepos(tree ?? [], shownPaths);
  const projectItem = (item: SidebarItem): JSX.Element[] => {
    if (item.kind === "repo") {
      const { repo, kept } = item;
      if (repo.missing || repeated.has(repo.id)) return [];
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
    const rows = item.items.flatMap(projectItem);
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
        {open && rows.length > 0 && <ul className="ws-repos ws-repos-nested">{rows}</ul>}
      </li>,
    ];
  };
  // A project with nothing archived is already its cards above: its own row would say the same again.
  const hasProjects = (tree ?? []).some((i) => i.kind !== "repo" || !i.repo.missing) && !projectListRepeatsCards(tree ?? [], shownPaths);

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
    // The parent items; Open is offered only while the parent row is in the list.
    const lineageMenu = (wt: WorktreeView, repo: RepoView) => {
      const parent = parentOf(wt, repo.worktrees);
      const parentShown = parent !== null && shownPaths.has(parent.path);
      return {
        parentPath: parent?.path ?? null,
        canSetParent: parentCandidates(wt, repo.worktrees).length > 0,
        onSetParent: props.onSetParent && (() => props.onSetParent?.(wt)),
        onOpenParent: parentShown && parent ? () => props.onSelect(parent) : undefined,
        onRemoveParent: props.onRemoveParent && (() => props.onRemoveParent?.(wt)),
        children: childrenOf(wt, repo.worktrees).length,
        onDeleteNested: props.onDeleteNested && (() => props.onDeleteNested?.(wt)),
      };
    };
    const projectItems = (repo: (typeof repoList)[number]) => {
      const kept = keptOf(repo.id);
      return projectMenuItems({
        path: repo.path,
        apps,
        openIn: (target) => props.onOpenIn?.(repo.path, target),
        copy,
        repoSettings: () => props.onRepoSettings?.(repo),
        remove: () => props.onRemoveRepo?.(repo),
        review: kept.length > 0 && props.onReviewBranches ? { label: t("project.review", { count: kept.length }), run: () => props.onReviewBranches?.(repo.id) } : null,
        ...groupMenu(repo.id),
      });
    };
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
        ...lineageMenu(wt, entries.find((e) => e.path === menu.key)!.repo),
        onMoveStatus: props.onMoveStatus && ((status: WorkStatus | null) => props.onMoveStatus?.(wt, status)),
        onRenameBranch: props.onRenameBranch && (() => props.onRenameBranch?.(wt)),
        onCheckoutBranch: props.onCheckoutBranch && (() => props.onCheckoutBranch?.(wt)),
        onArchive: props.onArchive && (() => props.onArchive?.(wt)),
        onHide: props.onPrefs && (() => props.onPrefs?.(setWorktreeShown(prefs, wt.path, false, false))),
        asleep: props.asleep?.[wt.path] === true,
        sleepable: props.sleepable?.[wt.path] !== false,
        onSleep: props.onSleep && (() => props.onSleep?.(wt)),
        onSleepNested: props.onSleepNested && (() => props.onSleepNested?.(wt)),
        nestedSleepable: [wt, ...childrenOf(wt, entries.find((e) => e.path === menu.key)!.repo.worktrees)].some((w) => props.sleepable?.[w.path] !== false),
        onWake: props.onWake && (() => props.onWake?.(wt)),
      });
      // A project without a row of its own (see `repeated`) has its menu ride on the card.
      const owner = repoList.find((r) => r.worktrees.some((w) => w.path === wt.path));
      const lone = owner && (!hasProjects || repeated.has(owner.id)) ? owner : undefined;
      if (lone) items = [...items, { id: "projectSep", labelKey: "", kind: "separator" as const }, { id: "project", labelKey: "project.menu", children: projectItems(lone) }];
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
      items = projectItems(repo);
    }
    return <ContextMenu key={`${menu.kind}:${menu.key}`} at={menu.at} items={items} onClose={() => setMenu(null)} />;
  };

  return (
    <div
      className="ws-worktrees"
      data-layout={compact ? "compact" : undefined}
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
        {props.onPrefs && <SidebarFilters prefs={prefs} hidden={shown.hidden} projects={repoList.filter((r) => !r.missing).map((r) => ({ id: r.id, name: r.shortName }))} onPrefs={props.onPrefs} sleepingOnly={sleepingOnly} onSleepingOnly={setSleepingOnly} />}
        {props.onPrefs && <SidebarOptions prefs={prefs} onPrefs={props.onPrefs} onOpenVisibility={() => setVisOpen(true)} />}
        {props.onOpenBoard && (
          <button type="button" className="ws-icon-btn" aria-label={t("kanban.open")} title={t("kanban.open")} onClick={() => props.onOpenBoard?.()}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h5v14H4zM15 5h5v9h-5z" />
            </svg>
          </button>
        )}
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
            {drawnTree.flatMap(projectItem)}
          </ul>
        )}
        {props.onPrefs && freshExternal.length > 0 && (
          <p className="ws-review-line" role="status">
            <span>{t("visibility.review.new", { count: freshExternal.length })}</span>
            <Button variant="secondary" onClick={() => setVisOpen(true)}>
              {t("visibility.review.action")}
            </Button>
          </p>
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
      {portsOpen && <PortsPopover ports={props.ports?.[portsOpen.worktree.path] ?? []} at={portsOpen.at} confirming={stopAsk} onOpenBrowser={(p) => props.onOpenPort?.(p)} onCopy={(p) => props.onCopyPort?.(p)} onAskStop={(p) => setStopAsk({ pid: p.pid, since: Date.now() })} onStop={(p) => {
        setStopAsk(null);
        void props.onStopPort?.(portsOpen.worktree, p);
      }} onClose={() => { setPortsOpen(null); setStopAsk(null); }} />}
      <div className="ws-sidebar-foot">
        <button type="button" className="ws-add-repo" onClick={() => props.onAddRepo()}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="ws-add-label">{t("workspace.addRepo")}</span>
        </button>
        {props.onAddFolder && (
          <button type="button" className="ws-add-repo ws-add-secondary" title={t("folder.add")} aria-label={t("folder.add")} onClick={() => props.onAddFolder?.()}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h6l2 2h10v10H3z" />
            </svg>
            <span className="ws-add-label">{t("folder.add")}</span>
          </button>
        )}
        {props.onNewGroup && (
          <button type="button" className="ws-add-repo ws-add-secondary" title={t("group.new")} aria-label={t("group.new")} onClick={() => props.onNewGroup?.()}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16M4 12h16M4 19h10" />
            </svg>
            <span className="ws-add-label">{t("group.new")}</span>
          </button>
        )}
        <SetupGuideEntry projects={props.items?.length} />
      </div>
      {visOpen && props.onPrefs && (
        <VisibilityDialog
          rows={visibilityRows(repoList.filter((r) => !r.missing), prefs)}
          defaultHidden={prefs.externalDefaultHidden}
          onDefaultHidden={(on) => props.onPrefs?.({ ...prefs, externalDefaultHidden: on })}
          onToggle={(row, on) => props.onPrefs?.(setWorktreeShown(prefs, row.path, row.external, on))}
          onRestoreAll={() => props.onPrefs?.(restoreAll(prefs, repoList.flatMap((r) => r.found.map((wt) => wt.path))))}
          onClose={() => {
            // Closing the review settles the new ones: they stay hidden and are not counted again.
            if (freshExternal.length > 0) props.onPrefs?.(acknowledgeNew(prefs, freshExternal));
            setVisOpen(false);
          }}
        />
      )}
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
