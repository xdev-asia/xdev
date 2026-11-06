import type { Check, MrSummary, PrView, PullPolicy, ReviewHost, ShipView } from "@/api";

export type ShipAction = "commit" | "publish" | "push" | "pull" | "diverged" | "create_pr" | "open_pr" | "none";

// What the main button does. The first rule that matches wins.
export function shipAction({
  checked,
  ship,
  pr,
  policy = "ff-only",
}: {
  checked: number;
  ship: ShipView | null;
  pr: PrView | null | undefined;
  // Pull policy: any policy but ff-only can reconcile a split history, so the button pulls.
  policy?: PullPolicy;
}): ShipAction {
  if (checked > 0) return "commit";
  if (ship === null || ship.branch === null || ship.remote === null) return "none";
  const up = ship.upstream;
  if (up === null) return "publish";
  if (up.ahead > 0 && up.behind > 0) return policy === "ff-only" || up.rewritten ? "diverged" : "pull";
  if (up.behind > 0) return "pull";
  if (up.ahead > 0) return "push";
  const open = pr != null && (pr.state === "open" || pr.state === "draft");
  // undefined means not loaded or the lookup failed: never offer create_pr then.
  if (pr === null && ship.aheadOfBase) return "create_pr";
  if (open) return "open_pr";
  return "none";
}

// The i18n key of the main button's text: the pull request words become merge request words on GitLab.
export function actionKey(action: ShipAction, host: ReviewHost): string {
  if (host === "gitlab") {
    if (action === "create_pr") return "ship.action.create_mr";
    if (action === "open_pr") return "ship.action.open_mr";
  }
  return `ship.action.${action}`;
}

// A merge request in the one shape the bar and the dialog hand around.
export function mrAsPr(mr: MrSummary): PrView {
  return {
    number: mr.iid,
    url: mr.url,
    state: mr.state === "open" ? (mr.draft ? "draft" : "open") : mr.state,
    title: mr.title,
    base: mr.target,
    head: mr.source,
  };
}

// Any failure beats pending, and pending beats pass. A cancelled run counts as a failure; a skipped
// one counts as a pass. No checks at all gives null.
export function checksSummary(checks: Check[]): "pass" | "fail" | "pending" | null {
  if (checks.length === 0) return null;
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "fail";
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  return "pass";
}
