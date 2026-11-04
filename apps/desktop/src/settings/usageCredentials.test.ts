import { expect, it } from "vitest";
import type { Account, Quota } from "@/api";
import { credentialRows } from "./usageCredentials";

type Reason = NonNullable<Quota["reason"]>;

const account = (name: string, provider: Account["provider"] = "claude"): Account => ({
  name,
  provider,
  dir: "/x",
  status: { state: "logged_in", email: null, plan: null, org: null },
});
const quota = (name: string, reason: Reason | null): Quota => ({ name, state: reason ? "unknown" : "ok", reason, windows: [], asOf: null });

it("maps each reason to a status, a note and whether Sign in helps", () => {
  const cases: [Reason | null, string, string | null, boolean][] = [
    [null, "found", null, false],
    ["no_credentials", "missing", null, true],
    ["expired", "expired", null, true],
    ["logged_out", "signedOut", null, true],
    ["no_claude", "cliMissing", null, false],
    ["no_codex", "cliMissing", null, false],
    ["no_sessions", "found", "noSessions", false],
    ["unavailable", "found", "unavailable", false],
  ];
  for (const [reason, status, note, canSignIn] of cases) {
    expect(credentialRows([account("a")], [quota("a", reason)])[0]).toMatchObject({ status, note, canSignIn });
  }
});

it("an account with no quota entry counts as found, and no accounts gives no rows", () => {
  expect(credentialRows([account("a", "codex")], [])[0]).toMatchObject({ name: "a", provider: "codex", status: "found" });
  expect(credentialRows([], [quota("a", "expired")])).toEqual([]);
});

it("carries no secrets: only name, provider, status, note and canSignIn", () => {
  expect(Object.keys(credentialRows([account("a")], [])[0]!).sort()).toEqual(["canSignIn", "name", "note", "provider", "status"]);
});
