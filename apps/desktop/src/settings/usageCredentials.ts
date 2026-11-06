import type { Account, Quota } from "@/api";

type Reason = NonNullable<Quota["reason"]>;

export type CredentialStatus = "found" | "missing" | "expired" | "signedOut" | "cliMissing";

export type CredentialRow = {
  name: string;
  provider: Account["provider"];
  status: CredentialStatus;
  /** Set for the reasons that leave the sign-in itself fine (no sessions yet, source unavailable). */
  note: "noSessions" | "unavailable" | "noQuotaSource" | null;
  /** Whether Sign in can help. */
  canSignIn: boolean;
};

const BY_REASON: Record<Reason, { status: CredentialStatus; note: CredentialRow["note"] }> = {
  no_credentials: { status: "missing", note: null },
  expired: { status: "expired", note: null },
  logged_out: { status: "signedOut", note: null },
  no_claude: { status: "cliMissing", note: null },
  no_codex: { status: "cliMissing", note: null },
  no_sessions: { status: "found", note: "noSessions" },
  unavailable: { status: "found", note: "unavailable" },
  no_cli: { status: "cliMissing", note: null },
  no_quota_source: { status: "found", note: "noQuotaSource" },
};

/** One row per account: what the last quota read says about its sign-in. Never carries a token. */
export function credentialRows(accounts: readonly Account[], quota: readonly Quota[]): CredentialRow[] {
  return accounts.map((a) => {
    const reason = quota.find((q) => q.name === a.name)?.reason ?? null;
    const { status, note } = reason === null ? { status: "found" as const, note: null } : BY_REASON[reason];
    return { name: a.name, provider: a.provider, status, note, canSignIn: status === "missing" || status === "expired" || status === "signedOut" };
  });
}
