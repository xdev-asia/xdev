import type { IssueDetail, RepoHooks } from "@/api";
import { ISSUE_PROMPT_BODY_MAX } from "./issueStart";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The variables an issue command can use, written `{name}`. */
export const ISSUE_VARS = ["number", "title", "url", "body", "labels", "repo"] as const;
export type IssueVar = (typeof ISSUE_VARS)[number];

/**
 * Fills `{name}` for each name in `vars`; any other `{x}` stays as typed. One pass, so a value that
 * itself holds `{title}` is not filled again. The result is a prompt for the agent, never a shell command.
 */
export function renderIssueCommand(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? vars[name] : whole));
}

/** The values for one issue: the body cut like the built-in prompt, comments left out. */
export function issueTemplateVars(detail: IssueDetail, repo: string, t: T): Record<IssueVar, string> {
  const chars = [...detail.body];
  const body = chars.length > ISSUE_PROMPT_BODY_MAX ? chars.slice(0, ISSUE_PROMPT_BODY_MAX).join("") : detail.body;
  return {
    number: String(detail.issue.number),
    title: detail.issue.title,
    url: detail.issue.url,
    body: body.trim() === "" ? t("issues.noBody") : body,
    labels: detail.issue.labels.join(", "),
    repo,
  };
}

/** This machine's text when not blank, else the shared `issue_command` once trusted, else none (as in Rust). */
export function effectiveIssueCommand(local: string, hooks: RepoHooks | null): string | null {
  if (local.trim() !== "") return local;
  return hooks?.issueCommand && hooks.issueCommandTrusted ? hooks.issueCommand : null;
}
