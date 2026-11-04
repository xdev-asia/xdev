import { expect, it } from "vitest";
import type { Issue, IssueDetail } from "@/api";
import { translate } from "@/i18n";
import { ISSUE_NAME_MAX, ISSUE_PROMPT_BODY_MAX, issuePrompt, issueWorkItem, issueWorktreeName } from "./issueStart";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const issue = (number: number, title: string): Issue => ({
  number, title, url: `https://github.com/o/r/issues/${number}`, state: "open",
  labels: [], assignees: [], author: null, updatedAt: "2026-11-03T00:00:00Z",
});

it("names the worktree from the number and the title", () => {
  expect(issueWorktreeName(issue(123, "Fix footer meter"))).toBe("123-fix-footer-meter");
  expect(issueWorktreeName(issue(5, "  Crash: `a/b`  (again)! "))).toBe("5-crash-a-b-again");
});

it("keeps Vietnamese letters as their base letters", () => {
  expect(issueWorktreeName(issue(9, "Sửa lỗi đồng bộ"))).toBe("9-sua-loi-dong-bo");
});

it("falls back to issue-N when the title leaves nothing", () => {
  expect(issueWorktreeName(issue(123, ""))).toBe("issue-123");
  expect(issueWorktreeName(issue(123, "日本語 !!!"))).toBe("issue-123");
});

it("caps the name and never ends in a dash", () => {
  const name = issueWorktreeName(issue(1234, "word ".repeat(30)));
  expect(name.length).toBeLessThanOrEqual(ISSUE_NAME_MAX);
  expect(name.startsWith("1234-word-word")).toBe(true);
  expect(name.endsWith("-")).toBe(false);
  expect(issueWorktreeName(issue(1, `${"a".repeat(37)} b`))).toBe(`1-${"a".repeat(37)}`);
});

const detail = (body: string): IssueDetail => ({
  issue: issue(12, "Fix it"),
  body,
  comments: [{ author: "x", body: "SECRET COMMENT", createdAt: "2026-11-03T00:00:00Z" }],
});

it("builds the prompt from title, url and body, without comments", () => {
  const text = issuePrompt(detail("Steps to reproduce"), t);
  expect(text).toContain("Fix it");
  expect(text).toContain("https://github.com/o/r/issues/12");
  expect(text).toContain("Steps to reproduce");
  expect(text).not.toContain("SECRET COMMENT");
});

it("cuts a long body and says so for an empty one", () => {
  const long = issuePrompt(detail("é".repeat(ISSUE_PROMPT_BODY_MAX + 50)), t);
  expect([...long].filter((c) => c === "é").length).toBe(ISSUE_PROMPT_BODY_MAX);
  expect(issuePrompt(detail("  "), t)).toContain(t("issues.noBody"));
});

it("makes the work item from the issue", () => {
  expect(issueWorkItem(issue(12, "Fix it"))).toEqual({ kind: "issue", url: "https://github.com/o/r/issues/12", title: "Fix it" });
});
