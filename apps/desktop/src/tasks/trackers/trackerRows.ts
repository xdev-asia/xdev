import type { Issue, IssueQuery, TaskSource, TrackerItem, TrackerPulls, TrackerStateKind } from "@/api";
import { issueQuery } from "@/issues/issueStart";

/** Rows per GitHub query, as the Rust clients' page size. */
export const GITHUB_LIMIT = 50;

/** The `localStorage` key of which sections show. */
export const SHOWN_KEY = "xdev.tasks.sources";

export type Shown = Record<TaskSource, boolean>;

export const ALL_SHOWN: Shown = { github: true, linear: true, jira: true };

/** A GitHub issue as a tracker row: `#12`, open → todo, closed → done. */
export function githubRows(issues: readonly Issue[]): TrackerItem[] {
  return issues.map((i) => ({
    source: "github",
    id: String(i.number),
    key: `#${i.number}`,
    title: i.title,
    state: i.state === "closed" ? "Closed" : "Open",
    stateKind: i.state === "closed" ? "done" : "todo",
    assignee: i.assignees[0] ?? null,
    url: i.url,
    updatedAt: i.updatedAt,
  }));
}

/** One query per box that is on: assigned to me, created by me. */
export function githubQueries(pulls: Pick<TrackerPulls, "assigned" | "created">): IssueQuery[] {
  const out: IssueQuery[] = [];
  if (pulls.assigned) out.push(issueQuery({ assigneeMe: true, limit: GITHUB_LIMIT }));
  if (pulls.created) out.push(issueQuery({ search: "author:@me", limit: GITHUB_LIMIT }));
  return out;
}

/** Lists joined, one row per issue number, newest update first. */
export function mergeGithub(lists: readonly (readonly Issue[])[]): Issue[] {
  const seen = new Map<number, Issue>();
  for (const list of lists) for (const issue of list) if (!seen.has(issue.number)) seen.set(issue.number, issue);
  return [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type StateTone = "neutral" | "accent" | "ok";

export function stateTone(kind: TrackerStateKind): StateTone {
  if (kind === "inProgress") return "accent";
  if (kind === "done") return "ok";
  return "neutral";
}

/** Which sections show; all of them when nothing usable is stored. */
export function loadShown(store?: Pick<Storage, "getItem">): Shown {
  try {
    const raw = (store ?? localStorage).getItem(SHOWN_KEY);
    if (raw === null) return { ...ALL_SHOWN };
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return { ...ALL_SHOWN };
    const o = v as Record<string, unknown>;
    return {
      github: o.github !== false,
      linear: o.linear !== false,
      jira: o.jira !== false,
    };
  } catch {
    return { ...ALL_SHOWN };
  }
}

export function saveShown(shown: Shown, store?: Pick<Storage, "setItem">): void {
  try {
    (store ?? localStorage).setItem(SHOWN_KEY, JSON.stringify(shown));
  } catch {
    // Storage is off: the choice just does not survive a reload.
  }
}
