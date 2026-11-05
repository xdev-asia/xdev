import { useState } from "react";
import type { JSX } from "react";
import { EmptyState, IconButton, ListRow, StatusDot } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { AgentIcon } from "@/workspace/AgentIcon";
import { ago } from "@/workspace/ago";
import { dashboardBuckets, type DashboardBucket } from "./dashboard";
import type { ThreadSource, WorktreeName } from "./threads";

const HEADING: Record<DashboardBucket, string> = {
  attention: "activity.dashboard.attention",
  working: "activity.dashboard.working",
  done: "activity.dashboard.done",
};

export interface AgentDashboardViewProps {
  buckets: ReturnType<typeof dashboardBuckets>;
  now: number;
  onJump(tabId: string): void;
  onDismiss(key: string): void;
}

/** The agent dashboard markup: agents grouped by what they need. `AgentDashboard` holds the dismissals. */
export function AgentDashboardView(props: AgentDashboardViewProps): JSX.Element {
  const { t } = useI18n();
  if (props.buckets.length === 0) return <EmptyState title={t("activity.dashboard.empty")} />;
  return (
    <ul className="act-list" aria-label={t("activity.dashboard.label")}>
      {props.buckets.flatMap((group) => [
        <li key={`g:${group.bucket}`} className="act-group" role="presentation">
          {t(HEADING[group.bucket], { count: group.rows.length })}
        </li>,
        ...group.rows.map((row) => {
          const { thread } = row;
          const where = [thread.worktreeName, thread.branch].filter((x): x is string => !!x);
          if (thread.lastOutput !== null) where.push(ago(thread.lastOutput, props.now, t));
          const dismissable = thread.tab.status === "done" || thread.tab.status === "failed";
          return (
            <ListRow
              key={row.key}
              as="li"
              leading={
                <>
                  <StatusDot state={row.dot} pulse={row.dot === "working"} label={t(`workspace.tabs.status.${thread.tab.status}`)} />
                  <AgentIcon profile={thread.tab.profileId} />
                </>
              }
              title={thread.tab.title ?? t("activity.untitled")}
              meta={where.join(" · ")}
              trailing={
                dismissable ? (
                  <IconButton
                    icon="close"
                    label={t("activity.dashboard.dismiss")}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDismiss(row.key);
                    }}
                  />
                ) : undefined
              }
              onClick={() => props.onJump(thread.tab.id)}
            />
          );
        }),
      ])}
    </ul>
  );
}

export interface AgentDashboardProps {
  sources: readonly ThreadSource[];
  names: Readonly<Record<string, WorktreeName>>;
  now: number;
  onJump(tabId: string): void;
}

/** The stateful agent dashboard; dismissals live in memory only. */
export function AgentDashboard(props: AgentDashboardProps): JSX.Element {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <AgentDashboardView
      buckets={dashboardBuckets(props.sources, props.names, dismissed)}
      now={props.now}
      onJump={props.onJump}
      onDismiss={(key) => setDismissed((prev) => new Set(prev).add(key))}
    />
  );
}
