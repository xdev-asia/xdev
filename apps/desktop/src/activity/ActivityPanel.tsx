import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Button, EmptyState, ListRow, SearchInput, Segmented } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { AgentIcon } from "@/workspace/AgentIcon";
import { ago } from "@/workspace/ago";
import type { Sessions } from "@/workspace/sessions";
import type { ActivityFeed, FeedEntry } from "./feed";
import { loadActivityOptions, saveActivityOptions, type ActivityOptions } from "./options";
import { activityThreads, hasAgentThreads, type ThreadGroup, type WorktreeName } from "./threads";

export type ActivityTab = "threads" | "feed";
type T = (key: string, vars?: Record<string, string | number>) => string;

export interface ActivityViewProps {
  tab: ActivityTab;
  query: string;
  options: ActivityOptions;
  groups: ThreadGroup[];
  /** Whether any agent thread exists before the search and the options narrow the list. */
  anyThreads: boolean;
  feed: readonly FeedEntry[];
  names: Readonly<Record<string, WorktreeName>>;
  now: number;
  /** Where the options menu is open (screen point), or null. */
  menuAt: { x: number; y: number } | null;
  onTab(tab: ActivityTab): void;
  onQuery(query: string): void;
  onOptions(options: ActivityOptions): void;
  onMenu(at: { x: number; y: number } | null): void;
  onJump(tabId: string): void;
  onClearFeed(): void;
}

/** The menu items for the two options, each a choice with a check. */
export function optionItems(options: ActivityOptions, onOptions: (o: ActivityOptions) => void): MenuItem[] {
  return [
    { id: "showIdle", labelKey: "activity.option.showIdle", checked: options.showIdle, run: () => onOptions({ ...options, showIdle: !options.showIdle }) },
    {
      id: "groupByWorktree",
      labelKey: "activity.option.groupByWorktree",
      checked: options.groupBy === "worktree",
      run: () => onOptions({ ...options, groupBy: options.groupBy === "worktree" ? "none" : "worktree" }),
    },
  ];
}

function threadRows(groups: ThreadGroup[], now: number, t: T, onJump: (id: string) => void): JSX.Element[] {
  return groups.flatMap((group) => {
    const rows = group.threads.map((th) => {
      const state = t(`workspace.tabs.status.${th.tab.status}`);
      const title = th.tab.title ?? t("activity.untitled");
      const where = [th.worktreeName, th.branch].filter((x): x is string => !!x).join(" · ");
      const when = th.lastOutput === null ? state : `${state} · ${ago(th.lastOutput, now, t)}`;
      return (
        <ListRow
          key={th.tab.id}
          as="li"
          leading={<AgentIcon profile={th.tab.profileId} />}
          title={title}
          meta={group.worktree === null ? `${where} · ${when}` : when}
          onClick={() => onJump(th.tab.id)}
        />
      );
    });
    if (group.worktree === null) return rows;
    return [
      <li key={`g:${group.worktree}`} className="act-group" role="presentation">
        {group.name}
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
  const list =
    tab === "threads"
      ? threadRows(props.groups, props.now, t, props.onJump)
      : feedRows(props.feed, props.names, props.now, t, props.onJump);
  const emptyKey =
    tab === "feed" ? "activity.empty.feed" : !props.anyThreads ? "activity.empty.threads" : "activity.empty.match";
  return (
    <section className="act-panel" aria-label={t("agentSessions.tab.activity")}>
      <div className="act-controls">
        <Segmented
          label={t("agentSessions.tab.activity")}
          value={tab}
          options={[
            { value: "threads", label: t("activity.tab.threads") },
            { value: "feed", label: t("activity.tab.feed") },
          ]}
          onChange={(v) => props.onTab(v as ActivityTab)}
        />
        {tab === "threads" ? (
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
          </>
        ) : (
          <Button variant="secondary" type="button" disabled={props.feed.length === 0} onClick={props.onClearFeed}>
            {t("activity.clear")}
          </Button>
        )}
      </div>
      {list.length === 0 ? (
        <EmptyState title={t(emptyKey)} />
      ) : (
        <ul className="act-list">{list}</ul>
      )}
      {props.menuAt && <ContextMenu at={props.menuAt} items={items} onClose={() => props.onMenu(null)} />}
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
  const groups = activityThreads(sources, props.names, query, options);
  const anyThreads = hasAgentThreads(sources);

  return (
    <ActivityView
      tab={tab}
      query={query}
      options={options}
      groups={groups}
      anyThreads={anyThreads}
      feed={entries}
      names={props.names}
      now={Date.now()}
      menuAt={menuAt}
      onTab={setTab}
      onQuery={setQuery}
      onOptions={(o) => {
        setOptions(o);
        saveActivityOptions(o);
      }}
      onMenu={setMenuAt}
      onJump={props.onJump}
      onClearFeed={() => feed.clear()}
    />
  );
}
