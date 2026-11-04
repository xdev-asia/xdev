import { expect, it } from "vitest";
import type { Accounts, Quota } from "@/api";
import { translate } from "@/i18n";
import { resetLabel, usageRows } from "./usageModel";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const now = Date.parse("2026-11-04T10:00:00Z");
const quota = (name: string, over: Partial<Quota> = {}): Quota => ({ name, state: "ok", reason: null, windows: [], asOf: null, ...over });
const accounts = (names: [string, "claude" | "codex"][]): Accounts => ({
  reservePercent: 30,
  accounts: names.map(([name, provider]) => ({ name, provider, dir: `/a/${name}`, status: { state: "logged_in", email: null, plan: null, org: null } })),
  active: [],
});

it("keeps the account order and joins the provider", () => {
  const rows = usageRows([quota("b"), quota("a")], accounts([["a", "claude"], ["b", "codex"]]), t);
  expect(rows.map((r) => [r.account, r.provider])).toEqual([["a", "claude"], ["b", "codex"]]);
});
it("lists a quota without an account after the others, and works without accounts", () => {
  const rows = usageRows([quota("gone"), quota("a")], accounts([["a", "claude"], ["missing", "claude"]]), t);
  expect(rows.map((r) => r.account)).toEqual(["a", "gone"]);
  expect(rows[1]!.provider).toBeNull();
  expect(usageRows([quota("x"), quota("y")], null, t).map((r) => r.account)).toEqual(["x", "y"]);
});
it("rounds percent, keeps null, labels windows and parses the reset time", () => {
  const q = quota("a", { windows: [
    { key: "five_hour", utilization: 41.6, resetsAt: "2026-11-04T12:10:00Z" },
    { key: "seven_day", utilization: null, resetsAt: null },
    { key: "monthly", utilization: 120, resetsAt: "nonsense" },
  ] });
  const [row] = usageRows([q], null, t);
  expect(row!.windows).toEqual([
    { key: "five_hour", label: "5-hour", percent: 42, resetsAt: Date.parse("2026-11-04T12:10:00Z") },
    { key: "seven_day", label: "Weekly", percent: null, resetsAt: null },
    { key: "monthly", label: "monthly", percent: 120, resetsAt: null },
  ]);
});
it("asks to sign in only for expired, logged out and no credentials", () => {
  const reasons = ["no_credentials", "expired", "unavailable", "logged_out", "no_claude", "no_codex", "no_sessions"] as const;
  const rows = usageRows(reasons.map((reason) => quota(reason, { state: "unknown", reason })), null, t);
  expect(rows.filter((r) => r.signIn).map((r) => r.account)).toEqual(["no_credentials", "expired", "logged_out"]);
  expect(usageRows([quota("ok")], null, t)[0]!.signIn).toBe(false);
});
it("resetLabel: relative under a day, date and time beyond", () => {
  expect(resetLabel(null, now, t)).toBe("Reset time unknown");
  expect(resetLabel(now - 1, now, t)).toBe("Resetting now");
  expect(resetLabel(now + 5 * 60_000, now, t)).toBe("Resets in 5 min");
  expect(resetLabel(now + 130 * 60_000, now, t)).toBe("Resets in 2 h 10 min");
  expect(resetLabel(now + 25 * 3_600_000, now, t)).toMatch(/^Resets .*\d/);
  expect(resetLabel(now + 25 * 3_600_000, now, t)).not.toContain(" in ");
});

it("marks the active account of each provider", () => {
  const found = { ...accounts([["a", "claude"], ["b", "claude"], ["c", "codex"]]), active: [{ provider: "claude" as const, name: "b" }] };
  const rows = usageRows([quota("a"), quota("b"), quota("c")], found, t);
  expect(rows.map((r) => r.active)).toEqual([false, true, false]);
  expect(usageRows([quota("a")], null, t)[0].active).toBe(false);
});
