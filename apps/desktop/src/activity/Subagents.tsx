import type { JSX } from "react";
import { Badge, Disclosure, ListRow, StatusDot } from "@xdev-asia/ui";
import type { SessionState } from "@xdev-asia/ui";
import type { AgentSubagent } from "@/api";
import { ago } from "@/workspace/ago";
import type { Tab } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The dot of a sub-agent run. A pending run goes on only while its tab does; otherwise the session stopped in it. */
export function subagentDot(status: string, tab: TabStatus): SessionState {
  if (status === "ok") return "done";
  if (status === "error") return "failed";
  return tab === "working" || tab === "needs-you" ? "working" : "exited";
}

/** How many runs there are and how many of them go on now. */
export function subagentCount(runs: readonly AgentSubagent[], tab: TabStatus): { total: number; running: number } {
  return { total: runs.length, running: runs.filter((r) => subagentDot(r.status, tab) === "working").length };
}

/** The badge of a compact row: how many sub-agents it has. None without runs. */
export function subagentBadge(tab: Tab, t: T): JSX.Element | null {
  const runs = tab.subagents ?? [];
  if (runs.length === 0) return null;
  const { total, running } = subagentCount(runs, tab.status);
  return <Badge>{t(running > 0 ? "activity.subagents.countRunning" : "activity.subagents.count", { count: total, running })}</Badge>;
}

/**
 * The sub-agent runs of a tab as an indented, collapsible list item under its row; each run has a status dot
 * and jumps to the tab. None without runs.
 */
export function subagentItem(tab: Tab, now: number, t: T, onJump: (tabId: string) => void): JSX.Element | null {
  const runs = tab.subagents ?? [];
  if (runs.length === 0) return null;
  return (
    <li key={`${tab.id}:subagents`} className="act-sub" data-tab={tab.id}>
      <Disclosure title={t("activity.subagents.title")} count={runs.length}>
        <ul className="act-sub-list">
          {runs.map((run) => {
            const dot = subagentDot(run.status, tab.status);
            const meta = [run.agentType, t("activity.subagents.steps", { count: run.stepsTotal }), run.at > 0 ? ago(run.at, now, t) : null];
            return (
              <ListRow
                key={run.id}
                as="li"
                leading={<StatusDot state={dot} pulse={dot === "working"} label={t(`activity.subagents.status.${dot}`)} />}
                title={run.description || t("activity.subagents.untitled")}
                meta={meta.filter((x): x is string => !!x).join(" · ")}
                onClick={() => onJump(tab.id)}
              />
            );
          })}
        </ul>
      </Disclosure>
    </li>
  );
}
