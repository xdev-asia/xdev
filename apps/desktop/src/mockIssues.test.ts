import { expect, it } from "vitest";
import { createMockApi } from "./api";
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
