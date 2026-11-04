import type { Issue, IssueDetail, IssueQuery, WorkItem } from "@/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

export const ISSUE_NAME_MAX = 40;
/** Chars of the issue body the first prompt carries. */
export const ISSUE_PROMPT_BODY_MAX = 16 * 1024;

/** `123-fix-footer-meter`: the number, then the title in `[a-z0-9-]`; `issue-123` when the title leaves nothing. */
export function issueWorktreeName(issue: Issue): string {
  return numberedName(issue.number, issue.title, "issue");
}

/** `<number>-<title as [a-z0-9-]>` cut to `ISSUE_NAME_MAX`, or `<fallback>-<number>` when the title leaves nothing. */
export function numberedName(number: number, title: string, fallback: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return `${fallback}-${number}`;
  return `${number}-${slug}`.slice(0, ISSUE_NAME_MAX).replace(/-+$/, "");
}

/** Title, URL and body; comments are left out. */
export function issuePrompt(detail: IssueDetail, t: T): string {
  const chars = [...detail.body];
  const body = chars.length > ISSUE_PROMPT_BODY_MAX ? chars.slice(0, ISSUE_PROMPT_BODY_MAX).join("") : detail.body;
  return t("issues.prompt", {
    number: detail.issue.number,
    title: detail.issue.title,
    url: detail.issue.url,
    body: body.trim() === "" ? t("issues.noBody") : body,
  });
}

export function issueWorkItem(issue: Issue): WorkItem {
  return { kind: "issue", url: issue.url, title: issue.title };
}

/** An `IssueQuery` with every field set; the bindings have no optional fields. */
export function issueQuery(patch: Partial<IssueQuery> = {}): IssueQuery {
  return { state: null, assigneeMe: false, search: null, limit: null, ...patch };
}

/** `name`, or `name-2`, `name-3` ... the first one not in `taken`. */
export function uniqueWorktreeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`;
}

/** True for a hash and an issue number, or a GitHub issue URL: what the create dialog treats as an issue, not a name. */
export function isIssueRef(text: string): boolean {
  const t = text.trim();
  return /^#\d+$/.test(t) || /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+\/?$/.test(t);
}
