import type { RepoEnvVar } from "@/api";

/** A row being edited. A secret row keeps no value of its own: `value` is only what was typed this time. */
export type EnvRow = {
  /** Stable for React; not saved. */
  id: number;
  key: string;
  value: string;
  secret: boolean;
  /** The keychain already holds this secret row's value. */
  stored: boolean;
};

export type KeyProblem = "invalid" | "reserved" | "duplicate";

export const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_PREFIX = "XDEV_";
export const ENV_MAX = 100;

/** Why a key cannot be saved; undefined when it can. A blank key is `invalid`. */
export function keyProblem(key: string, rows: readonly EnvRow[], self: number): KeyProblem | undefined {
  const k = key.trim();
  if (!KEY_PATTERN.test(k)) return "invalid";
  if (k.startsWith(RESERVED_PREFIX)) return "reserved";
  if (rows.some((r) => r.id !== self && r.key.trim() === k)) return "duplicate";
  return undefined;
}

/** A row nobody typed in: it is dropped on save rather than refused. */
export function isBlank(row: EnvRow): boolean {
  return row.key.trim() === "" && row.value === "";
}

/** Whether every row that is not blank has a usable key. */
export function rowsValid(rows: readonly EnvRow[]): boolean {
  const kept = rows.filter((r) => !isBlank(r));
  return kept.length <= ENV_MAX && kept.every((r) => keyProblem(r.key, rows.filter((o) => !isBlank(o)), r.id) === undefined);
}

/** The rows the form starts from. */
export function rowsFrom(env: readonly RepoEnvVar[] | undefined, storedKeys: readonly string[], firstId = 1): EnvRow[] {
  return (env ?? []).map((r, i) => ({
    id: firstId + i,
    key: r.key,
    value: r.secret ? "" : r.value,
    secret: r.secret,
    stored: r.secret && storedKeys.includes(r.key),
  }));
}

/** The list `repoUpdate` takes: no blank rows, keys trimmed, no secret value. */
export function toPatch(rows: readonly EnvRow[]): RepoEnvVar[] {
  return rows
    .filter((r) => !isBlank(r))
    .map((r) => ({ key: r.key.trim(), value: r.secret ? "" : r.value, secret: r.secret }));
}

/** What to do with the keychain after the list is saved. */
export type SecretPlan = { set: { key: string; value: string }[]; clear: string[] };

/**
 * `before` is the stored list (with the keys whose value is in the keychain), `after` the saved rows. A secret
 * row with typed text is written; a secret key that is gone, or is now plain, is cleared. A secret row left
 * empty keeps what the keychain has.
 */
export function secretPlan(before: readonly RepoEnvVar[] | undefined, after: readonly EnvRow[]): SecretPlan {
  const kept = after.filter((r) => !isBlank(r));
  const set = kept.filter((r) => r.secret && r.value !== "").map((r) => ({ key: r.key.trim(), value: r.value }));
  const stillSecret = new Set(kept.filter((r) => r.secret).map((r) => r.key.trim()));
  const clear = (before ?? []).filter((r) => r.secret && !stillSecret.has(r.key)).map((r) => r.key);
  return { set, clear };
}

/** Whether the rows differ from what is saved (a typed secret counts). */
export function envChanged(saved: readonly RepoEnvVar[] | undefined, rows: readonly EnvRow[]): boolean {
  if (rows.some((r) => r.secret && r.value !== "")) return true;
  return JSON.stringify(toPatch(rows)) !== JSON.stringify(saved ?? []);
}
