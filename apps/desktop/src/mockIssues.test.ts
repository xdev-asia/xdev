import { expect, it } from "vitest";
import { createMockApi, type PrQuery } from "./api";
import { issueQuery } from "./issues/issueStart";

const api = createMockApi({});

it("lists open issues, closed ones, mine and by search", async () => {
  expect((await api.issuesList("r", issueQuery())).map((i) => i.number)).toEqual([1, 2]);
  expect((await api.issuesList("r", issueQuery({ state: "closed" }))).map((i) => i.number)).toEqual([3]);
  expect((await api.issuesList("r", issueQuery({ assigneeMe: true }))).map((i) => i.number)).toEqual([1]);
  expect((await api.issuesList("r", issueQuery({ search: "DARK" }))).map((i) => i.number)).toEqual([2]);
});

it("views an issue with its comments and rejects an unknown one", async () => {
  const detail = await api.issueView("r", 1);
  expect(detail.issue.title).toBe("Footer meter overflows");
  expect(detail.comments).toHaveLength(1);
  await expect(api.issueView("r", 99)).rejects.toMatchObject({ code: "issue_not_found" });
});

it("resolves #1 and the fixture URL, refuses another repo", async () => {
  expect((await api.issueResolve("r", "#1"))?.number).toBe(1);
  expect((await api.issueResolve("r", "https://github.com/example/demo/issues/2"))?.number).toBe(2);
  expect(await api.issueResolve("r", "#99")).toBeNull();
  expect(await api.issueResolve("r", "nonsense")).toBeNull();
  await expect(api.issueResolve("r", "https://github.com/other/x/issues/1")).rejects.toMatchObject({ code: "issue_other_repo" });
});

const prQuery = (patch: Partial<PrQuery> = {}): PrQuery => ({ state: null, mine: false, needsReview: false, search: null, limit: null, ...patch });

it("filters pull requests: open, mine, needs review, merged", async () => {
  expect((await api.prsList("r", prQuery())).map((p) => p.number)).toEqual([10, 11, 13]);
  expect((await api.prsList("r", prQuery({ mine: true }))).map((p) => p.number)).toEqual([10]);
  expect((await api.prsList("r", prQuery({ needsReview: true }))).map((p) => p.number)).toEqual([11]);
  expect((await api.prsList("r", prQuery({ state: "merged" }))).map((p) => p.number)).toEqual([12]);
  expect((await api.prsList("r", prQuery({ state: "all", search: "DARK" }))).map((p) => p.number)).toEqual([11]);
});

it("gives a pull request branch, pr-<n> for a fork, and rejects an unknown number", async () => {
  expect(await api.prBranch("r", 10)).toBe("fix-footer");
  expect(await api.prBranch("r", 13)).toBe("pr-13");
  expect((await api.prGet("r", 13)).fork).toBe(true);
  await expect(api.prBranch("r", 99)).rejects.toMatchObject({ code: "pr_not_found" });
  await expect(api.prOpen("r", 99)).rejects.toMatchObject({ code: "pr_not_found" });
});

it("opening an unknown project fails as gh does", async () => {
  await expect(api.projectOpen("r", 999)).rejects.toMatchObject({ code: "gh_failed" });
});

it("lists an open and a closed project", async () => {
  expect((await api.projectsList("r")).map((p) => p.closed)).toEqual([false, true]);
});

it("creates an issue that the list then shows, and refuses a blank title", async () => {
  const mine = createMockApi({});
  const made = await mine.issueCreate("r", { title: "  New thing ", body: "" });
  expect(made).toMatchObject({ number: 4, title: "New thing", state: "open" });
  expect((await mine.issuesList("r", issueQuery())).map((i) => i.number)).toEqual([4, 1, 2]);
  expect((await mine.issueView("r", 4)).issue.title).toBe("New thing");
  await expect(mine.issueCreate("r", { title: "  ", body: "" })).rejects.toMatchObject({ code: "bad_draft" });
  expect((await api.issuesList("r", issueQuery())).map((i) => i.number)).toEqual([1, 2]);
});
