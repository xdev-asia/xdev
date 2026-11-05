import { expect, it } from "vitest";
import type { Account, Quota } from "@/api";
import en from "@/i18n/en.json";
import vi from "@/i18n/vi.json";
import { loginAction, needsReauth, statusBadge } from "./accountStatus";

const account = (state: Account["status"]["state"]): Account => ({ name: "a", provider: "claude", dir: "/d", status: { state, email: null, plan: null, org: null } });
const quota = (reason: string | null): Quota => ({ name: "a", state: "unknown", reason, windows: [], asOf: null }) as Quota;

it("decides the badge and the action per state", () => {
  const table: [Account, Quota | undefined, string, string | null][] = [
    [account("logged_in"), quota("expired"), "accounts.status.needsReauth", "accounts.signInAgain"],
    [account("logged_in"), quota("ok"), "accounts.status.logged_in", null],
    [account("logged_out"), quota("expired"), "accounts.status.logged_out", "accounts.login"],
    [account("logged_out"), quota(null), "accounts.status.logged_out", "accounts.login"],
    [account("logged_in"), undefined, "accounts.status.logged_in", null],
  ];
  for (const [a, q, badge, action] of table) {
    expect(statusBadge(a, q).key).toBe(badge);
    expect(loginAction(a, q)?.key ?? null).toBe(action);
  }
  expect(needsReauth(account("logged_in"), quota("expired"))).toBe(true);
  expect(needsReauth(account("logged_out"), quota("expired"))).toBe(false);
  expect(statusBadge(account("logged_in"), quota("expired")).state).toBe("reauth");
});

it("has the new strings in both languages", () => {
  for (const key of ["accounts.status.needsReauth", "accounts.signInAgain", "usage.menu.hide", "usage.menu.manage", "usage.menu.hidden", "usage.menu.undo", "usage.popover.connect", "usage.popover.emptyHint"]) {
    expect(en).toHaveProperty(key);
    expect(vi).toHaveProperty(key);
  }
});
