import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Button, EmptyState, StatusDot, Tooltip, ListRow, SearchInput, Segmented } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { openMissionControl } from "@/orchestration/missionEvents";
import { reasonKey } from "@/workspace/attention";
import { CloseTabsDialog } from "@/workspace/CloseTabsDialog";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { profileName } from "@/agents/profileStore";
import { AgentIcon } from "@/workspace/AgentIcon";
import { ago } from "@/workspace/ago";
import { useStatusSettings } from "@/status/statusSettings";
import { pushToast } from "@/workspace/toastStore";
import type { Sessions, Tab } from "@/workspace/sessions";
import type { ActivityFeed, FeedEntry } from "./feed";
import { AgentDashboard } from "./AgentDashboard";
import { clear as clearSelection, range, toggle, type Selection } from "./selection";
import { loadActivityOptions, saveActivityOptions, type ActivityFilter, type ActivityGroupBy, type ActivityOptions } from "./options";
import { activityThreads, hasAgentThreads, type ThreadGroup, type WorktreeName } from "./threads";
import { subagentBadge, subagentItem } from "./Subagents";

export type ActivityTab = "threads" | "feed" | "agents";
type T = (key: string, vars?: Record<string, string | number>) => string;

export interface ActivityViewProps {
  tab: ActivityTab;
  query: string;
  options: ActivityOptions;
  groups: ThreadGroup[];
  /** Whether any agent thread exists before the search and the options narrow the list. */
  anyThreads: boolean;
  feed: readonly FeedEntry[];
  /** The agent dashboard, shown on the agents tab. */
  agents?: JSX.Element;
  names: Readonly<Record<string, WorktreeName>>;
  now: number;
  /** Where the options menu is open (screen point), or null. */
  menuAt: { x: number; y: number } | null;
  /** The tabs picked in the list, and the one a Shift+click ranges from. */
  selected: Selection;
  anchor: string | null;
  /** Where a row's menu is open (screen point) and for which tab, or null. */
  rowMenu: { x: number; y: number; tabId: string } | null;
  onTab(tab: ActivityTab): void;
  onQuery(query: string): void;
  onOptions(options: ActivityOptions): void;
  onMenu(at: { x: number; y: number } | null): void;
  onSelection(selected: Selection, anchor: string | null): void;
  onRowMenu(menu: { x: number; y: number; tabId: string } | null): void;
  onJump(tabId: string): void;
  onCloseTab(tabId: string): void;
  /** Marks these tabs read or unread. */
  onMarkRead(ids: string[]): void;
  onMarkUnread(ids: string[]): void;
  onClearFeed(): void;
}

/** The menu items for the two on/off options, each a choice with a check. */
export function optionItems(options: ActivityOptions, onOptions: (o: ActivityOptions) => void): MenuItem[] {
  return [
    { id: "showIdle", labelKey: "activity.option.showIdle", checked: options.showIdle, run: () => onOptions({ ...options, showIdle: !options.showIdle }) },
    { id: "compact", labelKey: "activity.option.compact", checked: options.compact, run: () => onOptions({ ...options, compact: !options.compact }) },
  ];
}

/** Clears the feed and offers to undo it for a few seconds. Nothing to clear shows no toast. */
export function clearFeedWithUndo(feed: ActivityFeed, t: T): void {
  const token = feed.clear();
  if (token === 0) return;
  pushToast({ id: "activity-cleared", text: t("activity.cleared"), ttlMs: UNDO_MS, actions: [{ label: t("activity.undo"), run: () => void feed.restore(token) }] });
}

/** How long the undo toast stays. */
export const UNDO_MS = 6000;

/** The menu of one thread row: go to it, mark it read or unread, close it. */
export function rowItems(tab: Tab, on: { jump(id: string): void; markRead(ids: string[]): void; markUnread(ids: string[]): void; close(id: string): void }): MenuItem[] {
  return [
    { id: "jump", labelKey: "activity.row.jump", run: () => on.jump(tab.id) },
    tab.unread
      ? { id: "markRead", labelKey: "attention.markRead", run: () => on.markRead([tab.id]) }
      : { id: "markUnread", labelKey: "attention.markUnread", run: () => on.markUnread([tab.id]) },
    { id: "sep", labelKey: "", kind: "separator" },
    { id: "close", labelKey: "activity.row.close", danger: true, run: () => on.close(tab.id) },
  ];
}

const GROUP_OPTIONS: readonly ActivityGroupBy[] = ["none", "status", "worktree", "agent"];
const FILTER_OPTIONS: readonly ActivityFilter[] = ["all", "unread"];

/** The header text of a group: the status word, the worktree's name or the agent's name. */
function groupLabel(group: ThreadGroup, t: T): string {
  if (group.kind === "status") return t(`workspace.tabs.status.${group.key}`);
  if (group.kind === "agent") return profileName(null, group.key ?? "", t);
  return group.name ?? "";
}

function threadRows(groups: ThreadGroup[], now: number, t: T, props: ActivityViewProps): JSX.Element[] {
  const onJump = props.onJump;
  return groups.flatMap((group) => {
    const rows = group.threads.flatMap((th) => {
      const state = t(`workspace.tabs.status.${th.tab.status}`);
      const title = th.tab.title ?? t("activity.untitled");
      const where = [th.worktreeName, th.branch].filter((x): x is string => !!x).join(" · ");
      const age = th.lastOutput === null ? null : ago(th.lastOutput, now, t);
      // A header already says the status or the worktree, so the row leaves that out.
      const when = [group.kind === "status" ? null : state, age].filter((x): x is string => !!x).join(" · ");
      const reason = th.tab.unread && th.tab.unreadReason ? t(reasonKey(th.tab.unreadReason)) : null;
      const meta = [reason, group.kind === "worktree" ? when : [where, when].filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
      // Compact rows count the sub-agents; full rows list them under the thread.
      const subs = props.options.compact ? null : subagentItem(th.tab, now, t, onJump);
      const badge = props.options.compact ? subagentBadge(th.tab, t) : null;
      const markButton = (
        <button type="button" className="act-toggle" onClick={() => (th.tab.unread ? props.onMarkRead([th.tab.id]) : props.onMarkUnread([th.tab.id]))}>
          {t(th.tab.unread ? "attention.markRead" : "attention.markUnread")}
        </button>
      );
      const row = (
        <li
          key={th.tab.id}
          className="act-item"
          onClickCapture={(e) => {
            // Ctrl or Cmd adds the row to the selection, Shift picks a range; a plain click still jumps.
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            const ids = groups.flatMap((g) => g.threads.map((x) => x.tab.id));
            if (e.shiftKey) props.onSelection(range(ids, props.anchor, th.tab.id), props.anchor ?? th.tab.id);
            else props.onSelection(toggle(props.selected, th.tab.id), th.tab.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            props.onRowMenu({ x: e.clientX, y: e.clientY, tabId: th.tab.id });
          }}
        >
          <ListRow
            as="div"
            selected={props.selected.has(th.tab.id)}
            leading={
              <>
                <AgentIcon profile={th.tab.profileId} />
                {th.tab.unread && <StatusDot tone="accent" label={t("attention.unread")} />}
              </>
            }
            title={
              <Tooltip content={[th.worktreeName, state, reason, age].filter(Boolean).join(" · ")}>
                <span className="act-title">{title}</span>
              </Tooltip>
            }
            meta={meta}
            onClick={() => onJump(th.tab.id)}
            trailing={
              badge ? (
                <>
                  {badge}
                  {markButton}
                </>
              ) : (
                markButton
              )
            }
          />
        </li>
      );
      return subs ? [row, subs] : [row];
    });
    if (group.kind === "none") return rows;
    return [
      <li key={`g:${group.key}`} className="act-group" role="presentation">
        {groupLabel(group, t)}
      </li>,
      ...rows,
    ];
  });
}

function feedRows(feed: readonly FeedEntry[], names: ActivityViewProps["names"], now: number, t: T, onJump: (id: string) => void): JSX.Element[] {
  return feed.map((e) => (
    <ListRow
      key={e.id}
      as="li"
      leading={<AgentIcon profile={e.profileId} />}
      title={t("activity.feed.change", {
        tab: e.title ?? t("activity.untitled"), from: t(`workspace.tabs.status.${e.from}`), to: t(`workspace.tabs.status.${e.to}`) })}
      meta={`${names[e.worktree]?.name ?? e.worktree} · ${ago(e.at, now, t)}`}
      onClick={() => onJump(e.tabId)}
    />
  ));
}

/** The Activity view: the agent threads, or what they did. Pure markup; `ActivityPanel` holds the state. */
export function ActivityView(props: ActivityViewProps): JSX.Element {
  const { t } = useI18n();
  const { tab, query, options } = props;
  const items = optionItems(options, props.onOptions);
  const visible = props.groups.flatMap((g) => g.threads);
  const picked = visible.filter((th) => props.selected.has(th.tab.id)).map((th) => th.tab.id);
  const rowTab = props.rowMenu ? visible.find((th) => th.tab.id === props.rowMenu?.tabId)?.tab : undefined;
  const anyUnread = visible.some((th) => th.tab.unread);
  const list =
    tab === "threads"
      ? threadRows(props.groups, props.now, t, props)
      : feedRows(props.feed, props.names, props.now, t, props.onJump);
  const emptyKey =
    tab === "feed" ? "activity.empty.feed" : !props.anyThreads ? "activity.empty.threads" : "activity.empty.match";
  return (
    <section
      className="act-panel"
      aria-label={t("agentSessions.tab.activity")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && picked.length > 0) props.onSelection(clearSelection(), null);
      }}
    >
      <div className="act-controls">
        <Segmented
          label={t("agentSessions.tab.activity")}
          value={tab}
          options={[
            { value: "threads", label: t("activity.tab.threads") },
            { value: "feed", label: t("activity.tab.feed") },
            { value: "agents", label: t("activity.tab.agents") },
          ]}
          onChange={(v) => props.onTab(v as ActivityTab)}
        />
        {tab === "agents" ? null : tab === "threads" ? (
          <>
            <SearchInput
              size="sm"
              value={query}
              placeholder={t("activity.search")}
              aria-label={t("activity.search")}
              onChange={(e) => props.onQuery(e.target.value)}
              onClear={() => props.onQuery("")}
            />
            <Button
              variant="secondary"
              type="button"
              aria-haspopup="menu"
              aria-expanded={props.menuAt !== null}
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                props.onMenu({ x: box.left, y: box.bottom });
              }}
            >
              {t("activity.options")}
            </Button>
            <div className="act-controls-row">
              <Segmented
                label={t("activity.filter.label")}
                value={options.filter}
                options={FILTER_OPTIONS.map((v) => ({ value: v, label: t(`activity.filter.${v}`) }))}
                onChange={(v) => props.onOptions({ ...options, filter: v as ActivityFilter })}
              />
              <Segmented
                label={t("activity.group.label")}
                value={options.groupBy}
                options={GROUP_OPTIONS.map((v) => ({ value: v, label: t(`activity.group.${v}`) }))}
                onChange={(v) => props.onOptions({ ...options, groupBy: v as ActivityGroupBy })}
              />
              <Button variant="secondary" type="button" disabled={!anyUnread} onClick={() => props.onMarkRead(visible.map((th) => th.tab.id))}>
                {t("attention.markAllRead")}
              </Button>
            </div>
          </>
        ) : (
          <Button variant="secondary" type="button" disabled={props.feed.length === 0} onClick={props.onClearFeed}>
            {t("activity.clear")}
          </Button>
        )}
      </div>
      {tab === "threads" && picked.length > 0 && (
        <div className="act-bulk" role="toolbar" aria-label={t("activity.selected", { count: picked.length })}>
          <span className="act-bulk-count">{t("activity.selected", { count: picked.length })}</span>
          <Button variant="secondary" type="button" onClick={() => props.onMarkRead(picked)}>
            {t("attention.markRead")}
          </Button>
          <Button variant="secondary" type="button" onClick={() => props.onMarkUnread(picked)}>
            {t("attention.markUnread")}
          </Button>
          <Button variant="secondary" type="button" onClick={() => props.onSelection(clearSelection(), null)}>
            {t("activity.selection.clear")}
          </Button>
        </div>
      )}
      {tab === "agents" ? (
        props.agents
      ) : list.length === 0 ? (
        <EmptyState title={t(emptyKey)} />
      ) : (
        <ul className="act-list" data-density={options.compact ? "compact" : undefined}>{list}</ul>
      )}
      {props.menuAt && <ContextMenu at={props.menuAt} items={items} onClose={() => props.onMenu(null)} />}
      {rowTab && props.rowMenu && (
        <ContextMenu
          at={props.rowMenu}
          items={rowItems(rowTab, { jump: props.onJump, markRead: props.onMarkRead, markUnread: props.onMarkUnread, close: props.onCloseTab })}
          onClose={() => props.onRowMenu(null)}
        />
      )}
    </section>
  );
}

export interface ActivityPanelProps {
  sessions: Sessions;
  feed: ActivityFeed;
  names: Readonly<Record<string, WorktreeName>>;
  /** Which tab shows; a new `seq` sets it (the bell's "View activity" asks for the feed). */
  ask?: { tab: ActivityTab; seq: number };
  onJump(tabId: string): void;
}

/** The stateful Activity panel for the sidebar. */
export function ActivityPanel(props: ActivityPanelProps): JSX.Element {
  const { sessions, feed } = props;
  const [tab, setTab] = useState<ActivityTab>(props.ask?.tab ?? "threads");
  const [asked, setAsked] = useState(props.ask?.seq);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ActivityOptions>(loadActivityOptions);
  const { t } = useI18n();
  const statusSettings = useStatusSettings();
  const [selection, setSelection] = useState<{ selected: Selection; anchor: string | null }>({ selected: clearSelection(), anchor: null });
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [closing, setClosing] = useState<{ id: string; reason: "running" | "pinned" } | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  if (props.ask && props.ask.seq !== asked) {
    setAsked(props.ask.seq);
    setTab(props.ask.tab);
  }
  const entries = useSyncExternalStore(feed.subscribe.bind(feed), () => feed.snapshot(), () => feed.snapshot());
  // The tabs change often; any change draws the list again, and the clock moves it on every 30 s.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => sessions.subscribe(redraw), [sessions]);
  useEffect(() => {
    const id = setInterval(redraw, 30_000);
    return () => clearInterval(id);
  }, []);

  const sources = sessions
    .worktrees()
    .flatMap((w) => sessions.tabs(w))
    .map((tb) => ({ tab: tb, lastOutput: sessions.lastOutput(tb.id) }));
  const groups = activityThreads(sources, props.names, query, options, statusSettings);
  const anyThreads = hasAgentThreads(sources);
  const now = Date.now();

  // Closing a pinned tab or one whose agent is running asks first, as the tab strip does.
  function askClose(id: string): void {
    const found = sessions.tab(id);
    if (!found) return;
    const reason = found.pinned ? "pinned" : found.agent && found.exitCode === undefined && (found.status === "working" || found.status === "needs-you") ? "running" : null;
    if (reason) setClosing({ id, reason });
    else void sessions.close(id);
  }

  return (
    <>
    <ActivityView
      tab={tab}
      query={query}
      options={options}
      groups={groups}
      anyThreads={anyThreads}
      feed={entries}
      names={props.names}
      agents={
        <>
          <div className="act-mission">
            <Button variant="secondary" type="button" icon="workflow" onClick={() => openMissionControl("tabs")}>
              {t("mission.activity.open")}
            </Button>
          </div>
          <AgentDashboard sources={sources} names={props.names} now={now} compact={options.compact} onJump={props.onJump} />
        </>
      }
      now={now}
      menuAt={menuAt}
      selected={selection.selected}
      anchor={selection.anchor}
      onSelection={(selected, anchor) => setSelection({ selected, anchor })}
      rowMenu={rowMenu}
      onRowMenu={setRowMenu}
      onCloseTab={askClose}
      onTab={setTab}
      onQuery={setQuery}
      onOptions={(o) => {
        setOptions(o);
        saveActivityOptions(o);
      }}
      onMenu={setMenuAt}
      onJump={props.onJump}
      onMarkRead={(ids) => ids.forEach((id) => sessions.markTabRead(id))}
      onMarkUnread={(ids) => ids.forEach((id) => sessions.markTabUnread(id))}
      onClearFeed={() => clearFeedWithUndo(feed, t)}
    />
    {closing && (
      <CloseTabsDialog
        reason={closing.reason}
        onConfirm={() => {
          void sessions.close(closing.id);
          setClosing(null);
        }}
        onCancel={() => setClosing(null)}
      />
    )}
    </>
  );
}
