import type { Check, PrView, ShipView } from "../api";

export type ShipAction = "commit" | "publish" | "push" | "pull" | "diverged" | "create_pr" | "open_pr" | "none";

// What the main button does. The first rule that matches wins.
export function shipAction({ checked, ship, pr }: { checked: number; ship: ShipView | null; pr: PrView | null }): ShipAction {
  if (checked > 0) return "commit";
  if (ship === null || ship.branch === null || ship.remote === null) return "none";
  const up = ship.upstream;
  if (up === null) return "publish";
  if (up.ahead > 0 && up.behind > 0) return "diverged";
  if (up.behind > 0) return "pull";
  if (up.ahead > 0) return "push";
  const open = pr !== null && (pr.state === "open" || pr.state === "draft");
  if (pr === null && (ship.range?.commits.length ?? 0) > 0) return "create_pr";
  if (open) return "open_pr";
  return "none";
}

// Any failure beats pending, and pending beats pass. A cancelled run counts as a failure; a skipped
// one counts as a pass. No checks at all gives null.
export function checksSummary(checks: Check[]): "pass" | "fail" | "pending" | null {
  if (checks.length === 0) return null;
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "fail";
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  return "pass";
}
