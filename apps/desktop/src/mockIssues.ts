import type { Api, ApiError } from "./api";

type IssuesApi = Pick<Api, "issuesList" | "issueView" | "issueResolve">;

function reject(code: ApiError["code"]): Promise<never> {
  return Promise.reject({ code });
}

// Filled in by the issues lane (U1); until then every call reads as `gh` failing.
export function createMockIssues(): IssuesApi {
  return {
    issuesList: () => reject("gh_failed"),
    issueView: () => reject("gh_failed"),
    issueResolve: () => reject("gh_failed"),
  };
}
