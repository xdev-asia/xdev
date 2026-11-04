import type { Api, ApiError, Issue, IssueDetail } from "./api";

type IssuesApi = Pick<Api, "issuesList" | "issueView" | "issueResolve" | "issueOpen">;

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

/** Three fixed issues, one closed; the demo user is `me`. Filters like `gh issue list`. */
export function createMockIssues(): IssuesApi {
  return {
    async issuesList(_repoId, query) {
      const wantClosed = query.state === "closed";
      const search = (query.search ?? "").trim().toLowerCase();
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
      return structuredClone(
        ISSUES.filter((i) => (i.state === "closed") === wantClosed)
          .filter((i) => !query.assigneeMe || i.assignees.includes("me"))
          .filter((i) => search === "" || i.title.toLowerCase().includes(search) || i.labels.some((l) => l.toLowerCase().includes(search)))
          .slice(0, limit),
      );
    },
    async issueView(_repoId, number) {
      const found = ISSUES.find((i) => i.number === number);
      if (!found) return reject("issue_not_found");
      return structuredClone({ issue: found, ...DETAILS[number] });
    },
    async issueOpen(_repoId, number) {
      if (!ISSUES.some((i) => i.number === number)) return reject("issue_not_found");
    },
    async issueResolve(_repoId, text) {
      const t = text.trim();
      const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(t);
      if (url && url[1].toLowerCase() !== MOCK_ISSUE_REPO) return reject("issue_other_repo", url[1]);
      const digits = url ? url[2] : /^#?(\d+)$/.exec(t)?.[1];
      const number = digits === undefined ? 0 : Number(digits);
      return structuredClone(ISSUES.find((i) => i.number === number) ?? null);
    },
  };
}
