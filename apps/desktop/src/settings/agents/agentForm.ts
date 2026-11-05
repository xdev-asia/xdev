import type { Account, Permissions, Profile, ProfileView } from "@/api";

type EnvVar = Profile["env"][number];

/** The editor's text fields; list fields are one entry per line. */
export interface Draft {
  name: string;
  program: string;
  model: string;
  effort: string;
  /** `""` follows the global Approvals switch. */
  permissions: "" | Permissions;
  account: string;
  args: string;
  env: string;
  startup: string;
}

/** Non-empty trimmed lines. */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `NAME=value` per line, blanks skipped; `null` when a line has no `=` or no name. */
export function parseEnv(text: string): EnvVar[] | null {
  const out: EnvVar[] = [];
  for (const line of lines(text)) {
    const at = line.indexOf("=");
    if (at < 0) return null;
    const name = line.slice(0, at).trim();
    if (!name) return null;
    out.push({ name, value: line.slice(at + 1).trim() });
  }
  return out;
}

export function draftOf(p: Profile | null): Draft {
  return {
    name: p?.name ?? "",
    program: p?.program ?? "",
    model: p?.model ?? "",
    effort: p?.effort ?? "",
    permissions: p?.permissions ?? "",
    account: p?.account ?? "",
    args: (p?.args ?? []).join("\n"),
    env: (p?.env ?? []).map((e) => `${e.name}=${e.value}`).join("\n"),
    startup: (p?.startup ?? []).join("\n"),
  };
}

/** The profile a draft saves as, or `null` when a field cannot be read. */
export function profileOf(draft: Draft, base: Profile | null, id: string): Profile | null {
  const env = parseEnv(draft.env);
  const name = draft.name.trim();
  if (env === null || !name) return null;
  const custom = base === null || base.cli === null;
  const program = draft.program.trim();
  if (custom && !program) return null;
  const opt = (s: string) => s.trim() || null;
  return {
    id,
    name,
    cli: base?.cli ?? null,
    program: custom ? program : (base?.program ?? null),
    args: lines(draft.args),
    env,
    model: opt(draft.model),
    effort: opt(draft.effort),
    // Custom profiles have no flag mapping, so they always run as `ask`.
    permissions: custom ? null : draft.permissions || null,
    account: opt(draft.account),
    startup: lines(draft.startup),
    enabled: base?.enabled ?? true,
  };
}

/** Accounts a profile can run under: only `claude` and `codex` take one, of their own provider. */
export function accountsFor(view: ProfileView | null, accounts: Account[]): Account[] {
  const cli = view?.profile.cli;
  if (cli !== "claude" && cli !== "codex") return [];
  return accounts.filter((a) => a.provider === cli);
}

/** Ids no profile takes: the default shell and the default agent values. */
const RESERVED = ["shell", "auto", "blank"];

/** A free id made from a name: `[a-z0-9-]{1,32}`, not in `taken` or reserved. */
export function freeId(name: string, taken: string[], fallback: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || fallback;
  if (!taken.includes(base) && !RESERVED.includes(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}
