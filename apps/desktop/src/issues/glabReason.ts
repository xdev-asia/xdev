import type { ApiError } from "@/api";

const REASONS: readonly string[] = ["glab_missing", "glab_auth", "not_gitlab"];

/** The line for a failed `glab` call: a reason text for a glab set-up problem, else the error text with glab's own detail. */
export function glabReasonText(error: ApiError, t: (key: string) => string): string {
  const base = REASONS.includes(error.code) ? t(`gitlab.reason.${error.code}`) : t(`error.${error.code}`);
  return error.code === "glab_failed" && error.detail ? `${base} ${error.detail}` : base;
}
