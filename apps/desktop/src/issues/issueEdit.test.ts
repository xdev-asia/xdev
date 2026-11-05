import { expect, it } from "vitest";
import type { IssueDetail } from "@/api";
import { buildIssueEdit, EMPTY_EDIT, isEmptyEdit, toggled } from "./issueEdit";

function detail(over: Partial<IssueDetail["issue"]> = {}, body = "text"): IssueDetail {
  return {
    issue: { number: 4, url: "u", state: "open", title: "Title", labels: ["bug", "ui"], assignees: ["octo"], author: "me", updatedAt: "t", ...over },
    body,
    comments: [],
  };
}

it("an unchanged choice is an empty edit", () => {
  const d = detail();
  const edit = buildIssueEdit(d, { title: "Title", body: "text", labels: ["ui", "bug"], assignees: ["octo"] });
  expect(edit).toEqual(EMPTY_EDIT);
  expect(isEmptyEdit(edit)).toBe(true);
  expect(isEmptyEdit(buildIssueEdit(d, {}))).toBe(true);
});

it("diffs labels and assignees against the loaded issue", () => {
  const edit = buildIssueEdit(detail(), { labels: ["bug", "docs", "docs"], assignees: ["mona"] });
  expect(edit.addLabels).toEqual(["docs"]);
  expect(edit.removeLabels).toEqual(["ui"]);
  expect(edit.addAssignees).toEqual(["mona"]);
  expect(edit.removeAssignees).toEqual(["octo"]);
  expect(isEmptyEdit(edit)).toBe(false);
});

it("trims the title and ignores a blank or same one", () => {
  expect(buildIssueEdit(detail(), { title: "  New  " }).title).toBe("New");
  expect(buildIssueEdit(detail(), { title: "  Title " }).title).toBeNull();
  expect(buildIssueEdit(detail(), { title: "   " }).title).toBeNull();
});

it("sends the body only when it changed", () => {
  expect(buildIssueEdit(detail(), { body: "other" }).body).toBe("other");
  expect(buildIssueEdit(detail(), { body: "" }).body).toBe("");
  expect(buildIssueEdit(detail(), { body: "text" }).body).toBeNull();
});

it("closes with a reason and reopens, each only from the right state", () => {
  expect(buildIssueEdit(detail(), { state: "not_planned" })).toMatchObject({ state: "closed", closeReason: "not_planned" });
  expect(buildIssueEdit(detail(), { state: "completed" })).toMatchObject({ state: "closed", closeReason: "completed" });
  expect(buildIssueEdit(detail(), { state: "reopen" }).state).toBeNull();
  const closed = detail({ state: "closed" });
  expect(buildIssueEdit(closed, { state: "reopen" })).toMatchObject({ state: "open", closeReason: null });
  expect(buildIssueEdit(closed, { state: "completed" }).state).toBeNull();
});

it("toggles a name in a list", () => {
  expect(toggled(["a"], "b")).toEqual(["a", "b"]);
  expect(toggled(["a", "b"], "a")).toEqual(["b"]);
});
