import { expect, it } from "vitest";
import type { AccountSource } from "@/api";
import { ownAccount, runAccount } from "./ownAccount";

const tab = (account: string | null, accountSource: AccountSource | null) => ({ account, accountSource });

it("a terminal starts on an account only when the tab was started on it by name", () => {
  expect(ownAccount(tab("w", null))).toBe("w");
  expect(ownAccount(tab("w", "tab"))).toBe("w");
  // Once the pty says the account came from the default, routing or the profile, the start stays the same.
  for (const source of ["active", "routed", "profile"] as const) expect(ownAccount(tab("w", source))).toBeNull();
});

it("a restart, wake or reopen keeps the account the tab ran under, except a profile's", () => {
  for (const source of [null, "tab", "active", "routed"] as const) expect(runAccount(tab("w", source))).toBe("w");
  expect(runAccount(tab("w", "profile"))).toBeNull();
  expect(runAccount(tab(null, "active"))).toBeNull();
});
