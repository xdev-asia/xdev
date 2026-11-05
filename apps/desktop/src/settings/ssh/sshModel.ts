import type { SshHost, SshSyncReport } from "@/api";

/** The text fields of the add/edit form; the port stays text until it is checked. */
export interface HostForm {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  identityFile: string;
}

export type FormProblem = "alias" | "aliasTaken" | "port";

export const EMPTY_FORM: HostForm = { alias: "", hostName: "", user: "", port: "", identityFile: "" };

export function formOf(host: SshHost | null): HostForm {
  if (!host) return EMPTY_FORM;
  return {
    alias: host.alias,
    hostName: host.hostName,
    user: host.user ?? "",
    port: host.port === undefined || host.port === null ? "" : String(host.port),
    identityFile: host.identityFile ?? "",
  };
}

/** What `ssh` is given: no whitespace, not an option. Mirrors the Rust check. */
export function validAlias(alias: string): boolean {
  return alias !== "" && !alias.startsWith("-") && !/[\s\u0000-\u001f]/.test(alias);
}

/** The port as a number: empty is none, else a whole number 1..=65535; `false` when it is not one. */
export function parsePort(text: string): number | undefined | false {
  const t = text.trim();
  if (t === "") return undefined;
  if (!/^\d+$/.test(t)) return false;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : false;
}

/** What is wrong with `form`, by field; `taken` are the aliases of the other hosts. */
export function problems(form: HostForm, taken: readonly string[]): Partial<Record<"alias" | "port", FormProblem>> {
  const out: Partial<Record<"alias" | "port", FormProblem>> = {};
  const alias = form.alias.trim();
  if (!validAlias(alias)) out.alias = "alias";
  else if (taken.includes(alias)) out.alias = "aliasTaken";
  if (parsePort(form.port) === false) out.port = "port";
  return out;
}

/** The host a valid form describes; `id` is empty for a new one. */
export function hostOf(form: HostForm, id: string): SshHost {
  const alias = form.alias.trim();
  const port = parsePort(form.port);
  const host: SshHost = { id, alias, hostName: form.hostName.trim() || alias, source: "manual" };
  if (form.user.trim()) host.user = form.user.trim();
  if (typeof port === "number") host.port = port;
  if (form.identityFile.trim()) host.identityFile = form.identityFile.trim();
  return host;
}

/** `user@host:port`, leaving out what the host does not set. */
export function endpoint(host: SshHost): string {
  const at = host.user ? `${host.user}@` : "";
  const port = host.port ? `:${host.port}` : "";
  return `${at}${host.hostName}${port}`;
}

/** The hosts whose alias, address, user or port contain `query` (case insensitive). */
export function filterHosts(hosts: readonly SshHost[], query: string): SshHost[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...hosts];
  return hosts.filter((h) => `${h.alias} ${endpoint(h)}`.toLowerCase().includes(q));
}

/** The line under the sync button: an i18n key and its variables. */
export function syncLine(r: SshSyncReport): { key: string; vars: Record<string, number> } {
  if (r.missing) return { key: "ssh.sync.missing", vars: {} };
  return { key: "ssh.sync.done", vars: { added: r.added, updated: r.updated, unchanged: r.unchanged, skipped: r.skipped } };
}
