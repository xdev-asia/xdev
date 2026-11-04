import type { ApiError } from "@/api";

const REASONS: readonly string[] = ["gh_missing", "gh_auth", "not_github"];

/** The line for a failed `gh` call: a reason text for a gh set-up problem, else the error text with gh's own detail. */
export function ghReasonText(error: ApiError, t: (key: string) => string): string {
  const base = REASONS.includes(error.code) ? t(`issues.reason.${error.code}`) : t(`error.${error.code}`);
  return error.code === "gh_failed" && error.detail ? `${base} ${error.detail}` : base;
}
