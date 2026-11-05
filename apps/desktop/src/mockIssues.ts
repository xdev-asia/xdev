import type { Api, ApiError, Issue, IssueDetail, IssueEvent, IssueLabel, PrSummary, ProjectSummary } from "./api";

type IssuesApi = Pick<
  Api,
  "issuesList" | "issueView" | "issueResolve" | "issueOpen" | "issueCreate" | "issueEdit" | "issueComment" | "issueLabels" | "issueAssignable" | "issueTimeline" | "prsList" | "prGet" | "prOpen" | "prBranch" | "prBranchDiscard" | "projectsList" | "projectOpen"
>;

/** The repo the mock's issue URLs belong to. */
export const MOCK_ISSUE_REPO = "example/demo";
const URL_ROOT = `https://github.com/${MOCK_ISSUE_REPO}/issues`;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  return Promise.reject(detail === undefined ? { code } : { code, detail });
}

function issue(number: number, title: string, state: Issue["state"], labels: string[], assignees: string[], hoursAgo: number): Issue {
  return {
    number, title, state, labels, assignees,
    url: `${URL_ROOT}/${number}`,
    author: "hubot",
    updatedAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  };
}

const ISSUES: Issue[] = [
  issue(1, "Footer meter overflows", "open", ["bug", "ui"], ["me"], 2),
  issue(2, "Add dark theme to settings", "open", ["enhancement"], [], 30),
  issue(3, "Bump the build tools", "closed", [], ["octocat"], 200),
];

const DETAILS: Record<number, Pick<IssueDetail, "body" | "comments">> = {
  1: {
    body: "The meter wraps on narrow windows.\n\n- open a narrow window\n- watch the footer",
    comments: [{ author: "octocat", body: "Looking at it. **Thanks** for the report.", createdAt: new Date(NOW - 3_600_000).toISOString() }],
  },
  2: { body: "", comments: [] },
  3: { body: "Done in the last release.", comments: [] },
};

const LABELS: IssueLabel[] = [
  { name: "bug", color: "d73a4a" },
  { name: "docs", color: "0075ca" },
  { name: "ui", color: "a2eeef" },
];
const ASSIGNABLE = ["octo", "mona"];
const COMMENT_MAX = 64 * 1024;

const EVENTS: IssueEvent[] = [
  { kind: "labeled", actor: "hubot", subject: "bug", createdAt: new Date(NOW - 5 * 3_600_000).toISOString() },
  { kind: "assigned", actor: "hubot", subject: "me", createdAt: new Date(NOW - 4 * 3_600_000).toISOString() },
  { kind: "renamed", actor: "octocat", subject: "Footer meter overflows", createdAt: new Date(NOW - 3 * 3_600_000).toISOString() },
];

function pr(number: number, title: string, state: PrSummary["state"], head: string, author: string, hoursAgo: number, fork = false): PrSummary {
  return {
    number, title, state, head, author, fork,
    url: `https://github.com/${MOCK_ISSUE_REPO}/pull/${number}`,
    base: "main",
    updatedAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  };
}

// #11 is the one `needsReview` finds; #13 comes from a fork.
const PRS: PrSummary[] = [
  pr(10, "Fix the footer meter", "open", "fix-footer", "me", 3),
  pr(11, "Add a dark theme", "draft", "dark-theme", "octocat", 20),
  pr(12, "Bump the build tools", "merged", "bump-tools", "hubot", 300),
  pr(13, "Typo in the readme", "open", "patch-1", "stranger", 50, true),
];
const NEEDS_REVIEW = new Set([11]);

const PROJECTS: ProjectSummary[] = [
  { number: 1, title: "Roadmap", url: "https://github.com/example/projects/1", closed: false, items: 12 },
  { number: 2, title: "Launch week", url: "https://github.com/example/projects/2", closed: true, items: 4 },
];

/** Three fixed issues, one closed; the demo user is `me`. Filters like `gh issue list`. */
export function createMockIssues(): IssuesApi {
  // New issues of this instance, shown before the fixed ones.
  const made: Issue[] = [];
  // Edits and comments change this instance's copy, never the fixed seeds.
  const seeded: Issue[] = structuredClone(ISSUES);
  const details: Record<number, Pick<IssueDetail, "body" | "comments">> = structuredClone(DETAILS);
  const all = () => [...made, ...seeded];
  return {
    async issuesList(_repoId, query) {
      const wantClosed = query.state === "closed";
      const search = (query.search ?? "").trim().toLowerCase();
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
      return structuredClone(
        all().filter((i) => (i.state === "closed") === wantClosed)
          .filter((i) => !query.assigneeMe || i.assignees.includes("me"))
          .filter((i) => search === "" || i.title.toLowerCase().includes(search) || i.labels.some((l) => l.toLowerCase().includes(search)))
          .slice(0, limit),
      );
    },
    async issueView(_repoId, number) {
      const found = all().find((i) => i.number === number);
      if (!found) return reject("issue_not_found");
      return structuredClone({ issue: found, ...(details[number] ?? { body: "", comments: [] }) });
    },
    async issueOpen(_repoId, number) {
      if (!all().some((i) => i.number === number)) return reject("issue_not_found");
    },
    async issueCreate(_repoId, draft) {
      const title = draft.title.trim();
      if (title === "" || [...title].length > 256) return reject("bad_draft");
      const next = issue(Math.max(...all().map((i) => i.number)) + 1, title, "open", [], [], 0);
      next.author = "me";
      made.unshift(next);
      return structuredClone(next);
    },
    async issueEdit(_repoId, number, edit) {
      const found = all().find((i) => i.number === number);
      if (!found) return reject("issue_not_found");
      if (edit.title != null && (edit.title.trim() === "" || [...edit.title.trim()].length > 256)) return reject("bad_draft");
      if ([...edit.addLabels, ...edit.removeLabels, ...edit.addAssignees, ...edit.removeAssignees].some((t) => t.startsWith("-") || t.includes("\n"))) return reject("bad_draft");
      if (edit.state != null) found.state = edit.state;
      if (edit.body != null) details[number] = { body: edit.body, comments: details[number]?.comments ?? [] };
      if (edit.title != null) found.title = edit.title.trim();
      found.labels = [...found.labels.filter((l) => !edit.removeLabels.includes(l)), ...edit.addLabels.filter((l) => !found.labels.includes(l))];
      found.assignees = [...found.assignees.filter((a) => !edit.removeAssignees.includes(a)), ...edit.addAssignees.filter((a) => !found.assignees.includes(a))];
      found.updatedAt = new Date(NOW).toISOString();
      return { failed: [], error: null };
    },
    async issueComment(_repoId, number, body) {
      if (!all().some((i) => i.number === number)) return reject("issue_not_found");
      if (body.trim() === "") return reject("empty_comment");
      if ([...body].length > COMMENT_MAX) return reject("comment_too_large");
      const current = details[number] ?? { body: "", comments: [] };
      details[number] = { ...current, comments: [...current.comments, { author: "me", body, createdAt: new Date(NOW).toISOString() }] };
    },
    async issueLabels() {
      return structuredClone(LABELS);
    },
    async issueAssignable() {
      return [...ASSIGNABLE];
    },
    async issueTimeline(_repoId, number) {
      if (!all().some((i) => i.number === number)) return reject("issue_not_found");
      return structuredClone(EVENTS);
    },
    async prsList(_repoId, query) {
      const state = query.state ?? "open";
      const search = (query.search ?? "").trim().toLowerCase();
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
      return structuredClone(
        PRS.filter((p) => state === "all" || (state === "open" ? p.state === "open" || p.state === "draft" : p.state === state))
          .filter((p) => !query.mine || p.author === "me")
          .filter((p) => !query.needsReview || NEEDS_REVIEW.has(p.number))
          .filter((p) => search === "" || p.title.toLowerCase().includes(search))
          .slice(0, limit),
      );
    },
    async prGet(_repoId, number) {
      const found = PRS.find((p) => p.number === number);
      return found ? structuredClone(found) : reject("pr_not_found");
    },
    async prOpen(_repoId, number) {
      if (!PRS.some((p) => p.number === number)) return reject("pr_not_found");
    },
    async prBranch(_repoId, number) {
      const found = PRS.find((p) => p.number === number);
      if (!found) return reject("pr_not_found");
      return { branch: found.fork ? `pr-${number}` : found.head, fetched: found.fork };
    },
    async prBranchDiscard() {},
    async projectsList() {
      return structuredClone(PROJECTS);
    },
    async projectOpen(_repoId, number) {
      if (!PROJECTS.some((p) => p.number === number)) return reject("gh_failed");
    },
    async issueResolve(_repoId, text) {
      const t = text.trim();
      const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(t);
      if (url && url[1].toLowerCase() !== MOCK_ISSUE_REPO) return reject("issue_other_repo", url[1]);
      const digits = url ? url[2] : /^#?(\d+)$/.exec(t)?.[1];
      const number = digits === undefined ? 0 : Number(digits);
      return structuredClone(all().find((i) => i.number === number) ?? null);
    },
  };
}
