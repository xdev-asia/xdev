import type { IssueEvent } from "@/api";

const KEYS: Record<IssueEvent["kind"], string> = {
  assigned: "issues.timeline.assigned",
  unassigned: "issues.timeline.unassigned",
  closed: "issues.timeline.closed",
  reopened: "issues.timeline.reopened",
  labeled: "issues.timeline.labeled",
  unlabeled: "issues.timeline.unlabeled",
  renamed: "issues.timeline.renamed",
  cross_referenced: "issues.timeline.crossReferenced",
};

/** The i18n key and variables that describe one timeline event. */
export function timelineLine(event: IssueEvent, ghost: string): { key: string; vars: { actor: string; subject: string } } {
  return { key: KEYS[event.kind], vars: { actor: event.actor ?? ghost, subject: event.subject ?? "" } };
}
