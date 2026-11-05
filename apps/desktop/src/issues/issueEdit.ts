import type { IssueCloseReason, IssueDetail, IssueEdit } from "@/api";

/** What the user picked in the detail view; a field left out is unchanged. */
export interface IssueChoice {
  title?: string;
  body?: string;
  /** The labels the issue should end with. */
  labels?: readonly string[];
  /** The logins the issue should end with. */
  assignees?: readonly string[];
  /** Close with a reason, or reopen. */
  state?: IssueCloseReason | "reopen";
}

export const EMPTY_EDIT: IssueEdit = {
  title: null,
  body: null,
  state: null,
  closeReason: null,
  addLabels: [],
  removeLabels: [],
  addAssignees: [],
  removeAssignees: [],
};

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** The `gh` edit that turns `detail` into `choice`: only the changed parts are set. */
export function buildIssueEdit(detail: IssueDetail, choice: IssueChoice): IssueEdit {
  const { issue } = detail;
  const edit: IssueEdit = { ...EMPTY_EDIT, addLabels: [], removeLabels: [], addAssignees: [], removeAssignees: [] };
  if (choice.title !== undefined) {
    const title = choice.title.trim();
    if (title !== "" && title !== issue.title.trim()) edit.title = title;
  }
  if (choice.body !== undefined && choice.body !== detail.body) edit.body = choice.body;
  if (choice.state === "reopen") {
    if (issue.state === "closed") edit.state = "open";
  } else if (choice.state !== undefined && issue.state === "open") {
    edit.state = "closed";
    edit.closeReason = choice.state;
  }
  if (choice.labels !== undefined) {
    const want = unique(choice.labels);
    edit.addLabels = want.filter((l) => !issue.labels.includes(l));
    edit.removeLabels = unique(issue.labels).filter((l) => !want.includes(l));
  }
  if (choice.assignees !== undefined) {
    const want = unique(choice.assignees);
    edit.addAssignees = want.filter((a) => !issue.assignees.includes(a));
    edit.removeAssignees = unique(issue.assignees).filter((a) => !want.includes(a));
  }
  return edit;
}

/** True when `edit` changes nothing, so nothing is sent. */
export function isEmptyEdit(edit: IssueEdit): boolean {
  return (
    edit.title === null &&
    edit.body === null &&
    edit.state === null &&
    edit.addLabels.length === 0 &&
    edit.removeLabels.length === 0 &&
    edit.addAssignees.length === 0 &&
    edit.removeAssignees.length === 0
  );
}

/** `labels` with `name` toggled. */
export function toggled(list: readonly string[], name: string): string[] {
  return list.includes(name) ? list.filter((x) => x !== name) : [...list, name];
}
