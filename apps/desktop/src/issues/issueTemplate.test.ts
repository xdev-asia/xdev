import { expect, it } from "vitest";
import type { Issue, IssueDetail, RepoHooks } from "@/api";
import { translate } from "@/i18n";
import { ISSUE_VARS, effectiveIssueCommand, issueTemplateVars, renderIssueCommand } from "./issueTemplate";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("lists the variables a template can use", () => {
  expect(ISSUE_VARS).toEqual(["number", "title", "url", "body", "labels", "repo"]);
});

it("fills each known variable and keeps an unknown {x} as typed", () => {
  const vars = { number: "12", title: "Fix it", url: "https://x/12", body: "b", labels: "bug, ui", repo: "xdev" };
  expect(renderIssueCommand("Work on #{number}: {title} ({labels}) in {repo}\n{url}\n{body}", vars)).toBe("Work on #12: Fix it (bug, ui) in xdev\nhttps://x/12\nb");
  expect(renderIssueCommand("{number} {nope} {Title} {}", vars)).toBe("12 {nope} {Title} {}");
  expect(renderIssueCommand("{number}{number}", vars)).toBe("1212");
  expect(renderIssueCommand("", vars)).toBe("");
});

it("does not fill a variable from text that a value itself contains", () => {
  const vars = { number: "1", title: "see {body}", url: "u", body: "{number}", labels: "", repo: "r" };
  expect(renderIssueCommand("{title} / {body}", vars)).toBe("see {body} / {number}");
});

it("builds the variables from the issue detail, with the body cut and a placeholder when empty", () => {
  const issue: Issue = { number: 7, title: "Crash", url: "https://github.com/o/r/issues/7", state: "open", labels: ["bug", "ui"], assignees: [], author: null, updatedAt: "2026-11-03T00:00:00Z" };
  const detail = (body: string): IssueDetail => ({ issue, body, comments: [{ author: "x", body: "SECRET", createdAt: "2026-11-03T00:00:00Z" }] });
  const vars = issueTemplateVars(detail("Steps"), "xdev", t);
  expect(vars).toEqual({ number: "7", title: "Crash", url: "https://github.com/o/r/issues/7", body: "Steps", labels: "bug, ui", repo: "xdev" });
  expect(Object.values(vars).join(" ")).not.toContain("SECRET");
  expect(issueTemplateVars(detail("  "), "xdev", t).body).toBe(t("issues.noBody"));
  expect([...issueTemplateVars(detail("é".repeat(20_000)), "xdev", t).body]).toHaveLength(16 * 1024);
});

const hooks = (over: Partial<RepoHooks>): RepoHooks => ({ setup: null, archive: null, waitForSetup: false, policy: "ask", parseError: null, detected: null, shared: [], sharedTrusted: false, tabs: [], tabsTrusted: false, sharedHash: null, tabsHash: null, unknown: [], problems: [], issueCommand: null, issueCommandHash: null, issueCommandTrusted: false, ...over });

it("the effective command is the local text, else the trusted shared one, else none", () => {
  const shared = (trusted: boolean) => hooks({ issueCommand: "shared {title}", issueCommandHash: "h", issueCommandTrusted: trusted });
  expect(effectiveIssueCommand("local {title}", shared(true))).toBe("local {title}");
  expect(effectiveIssueCommand("local {title}", null)).toBe("local {title}");
  expect(effectiveIssueCommand("", shared(true))).toBe("shared {title}");
  expect(effectiveIssueCommand("  \n", shared(true))).toBe("shared {title}");
  expect(effectiveIssueCommand("", shared(false))).toBeNull();
  expect(effectiveIssueCommand("", hooks({}))).toBeNull();
  expect(effectiveIssueCommand("", null)).toBeNull();
});
