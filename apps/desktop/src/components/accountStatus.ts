import { isIsolated, type Account, type Quota } from "@/api";

/** A login the app still holds, whose quota read says the token expired: it must be signed in again. */
export function needsReauth(account: Account, quota: Quota | undefined): boolean {
  return account.status.state === "logged_in" && quota?.reason === "expired";
}

/** The sign-in badge: its i18n key and the `data-state` the stylesheet tints. */
export function statusBadge(account: Account, quota: Quota | undefined): { key: string; state: string } {
  if (needsReauth(account, quota)) return { key: "accounts.status.needsReauth", state: "reauth" };
  return { key: `accounts.status.${account.status.state}`, state: account.status.state };
}

/** Whether a row offers the sign-in action, and which label it carries. */
export function loginAction(account: Account, quota: Quota | undefined): { key: string } | null {
  // A single-account CLI is signed in with the CLI itself, outside xDev.
  if (!isIsolated(account.provider)) return null;
  if (needsReauth(account, quota)) return { key: "accounts.signInAgain" };
  if (account.status.state !== "logged_in" || quota?.reason === "expired") return { key: "accounts.login" };
  return null;
}
