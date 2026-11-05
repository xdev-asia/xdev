import type { LocalForward, SshHost, SshSyncReport } from "@/api";

/** The fields of the add/edit form; numbers and lists stay text until they are checked. */
export interface HostForm {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  identityFile: string;
  /** `-J`: a jump host or a comma list of them. */
  proxyJump: string;
  forwardAgent: boolean;
  /** One `local:host:remote` per line. */
  forwards: string;
  /** Seconds, 1 to 120; empty is the default. */
  connectTimeout: string;
  /** One `Key=Value` per line. */
  extraOptions: string;
}

export type FormProblem = "alias" | "aliasTaken" | "port" | "proxyJump" | "forwards" | "connectTimeout" | "extraOptions";
export type ProblemField = "alias" | "port" | "proxyJump" | "forwards" | "connectTimeout" | "extraOptions";

/** The fields under "Advanced" in the form. */
export const ADVANCED_FIELDS: readonly ProblemField[] = ["proxyJump", "forwards", "connectTimeout", "extraOptions"];

export const TIMEOUT_MIN = 1;
export const TIMEOUT_MAX = 120;

export const EMPTY_FORM: HostForm = {
  alias: "",
  hostName: "",
  user: "",
  port: "",
  identityFile: "",
  proxyJump: "",
  forwardAgent: false,
  forwards: "",
  connectTimeout: "",
  extraOptions: "",
};

/** `local:host:remote`, an IPv6 host in brackets. */
export function forwardLine(f: LocalForward): string {
  const host = f.remoteHost.includes(":") ? `[${f.remoteHost}]` : f.remoteHost;
  return `${f.localPort}:${host}:${f.remotePort}`;
}

export function formOf(host: SshHost | null): HostForm {
  if (!host) return EMPTY_FORM;
  return {
    alias: host.alias,
    hostName: host.hostName,
    user: host.user ?? "",
    port: host.port === undefined || host.port === null ? "" : String(host.port),
    identityFile: host.identityFile ?? "",
    proxyJump: host.proxyJump ?? "",
    forwardAgent: host.forwardAgent ?? false,
    forwards: (host.localForwards ?? []).map(forwardLine).join("\n"),
    connectTimeout: host.connectTimeoutSecs === undefined || host.connectTimeoutSecs === null ? "" : String(host.connectTimeoutSecs),
    extraOptions: (host.extraOptions ?? []).join("\n"),
  };
}

/** A word `ssh` takes as a value: no whitespace or control characters, not an option. Mirrors the Rust check. */
function plainWord(word: string): boolean {
  return !word.startsWith("-") && !/[\s\u0000-\u001f\u007f]/.test(word);
}

/** What `ssh` is given: no whitespace, not an option. Mirrors the Rust check. */
export function validAlias(alias: string): boolean {
  return alias !== "" && plainWord(alias);
}

/** The port as a number: empty is none, else a whole number 1..=65535; `false` when it is not one. */
export function parsePort(text: string): number | undefined | false {
  const t = text.trim();
  if (t === "") return undefined;
  if (!/^\d+$/.test(t)) return false;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : false;
}

/** The connect timeout: empty is none, else whole seconds 1..=120; `false` when it is not one. */
export function parseTimeout(text: string): number | undefined | false {
  const t = text.trim();
  if (t === "") return undefined;
  if (!/^\d+$/.test(t)) return false;
  const n = Number(t);
  return n >= TIMEOUT_MIN && n <= TIMEOUT_MAX ? n : false;
}

/** One `local:host:remote` line, the host in brackets when it is IPv6; `false` when it is not one. */
export function parseForward(line: string): LocalForward | false {
  const m = /^(\d+):(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(line.trim());
  if (!m) return false;
  const localPort = parsePort(m[1]);
  const remotePort = parsePort(m[4]);
  const remoteHost = m[2] ?? m[3];
  if (typeof localPort !== "number" || typeof remotePort !== "number" || !plainWord(remoteHost)) return false;
  return { localPort, remoteHost, remotePort };
}

/** The forwards of the text, blank lines skipped; `false` when a line is not one. */
export function parseForwards(text: string): LocalForward[] | false {
  const out: LocalForward[] = [];
  for (const line of lines(text)) {
    const f = parseForward(line);
    if (f === false) return false;
    out.push(f);
  }
  return out;
}

/** An extra option `Key=Value`: letters and digits for the key, a value that is not blank. Mirrors the Rust check. */
export function validExtraOption(option: string): boolean {
  const eq = option.indexOf("=");
  if (eq < 0) return false;
  const key = option.slice(0, eq);
  const value = option.slice(eq + 1);
  return /^[A-Za-z][A-Za-z0-9]*$/.test(key) && value.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(value);
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** What is wrong with `form`, by field; `taken` are the aliases of the other hosts. */
export function problems(form: HostForm, taken: readonly string[]): Partial<Record<ProblemField, FormProblem>> {
  const out: Partial<Record<ProblemField, FormProblem>> = {};
  const alias = form.alias.trim();
  if (!validAlias(alias)) out.alias = "alias";
  else if (taken.includes(alias)) out.alias = "aliasTaken";
  if (parsePort(form.port) === false) out.port = "port";
  const jump = form.proxyJump.trim();
  if (jump !== "" && !plainWord(jump)) out.proxyJump = "proxyJump";
  if (parseForwards(form.forwards) === false) out.forwards = "forwards";
  if (parseTimeout(form.connectTimeout) === false) out.connectTimeout = "connectTimeout";
  if (!lines(form.extraOptions).every(validExtraOption)) out.extraOptions = "extraOptions";
  return out;
}

/** The host a valid form describes; `id` is empty for a new one. */
export function hostOf(form: HostForm, id: string): SshHost {
  const alias = form.alias.trim();
  const port = parsePort(form.port);
  const timeout = parseTimeout(form.connectTimeout);
  const forwards = parseForwards(form.forwards);
  const host: SshHost = {
    id,
    alias,
    hostName: form.hostName.trim() || alias,
    source: "manual",
    forwardAgent: form.forwardAgent,
    localForwards: forwards === false ? [] : forwards,
    extraOptions: lines(form.extraOptions),
  };
  if (form.user.trim()) host.user = form.user.trim();
  if (typeof port === "number") host.port = port;
  if (form.identityFile.trim()) host.identityFile = form.identityFile.trim();
  if (form.proxyJump.trim()) host.proxyJump = form.proxyJump.trim();
  if (typeof timeout === "number") host.connectTimeoutSecs = timeout;
  return host;
}

/** The host sets any of the advanced fields. */
export function hasAdvanced(form: HostForm): boolean {
  return form.proxyJump.trim() !== "" || form.forwardAgent || form.forwards.trim() !== "" || form.connectTimeout.trim() !== "" || form.extraOptions.trim() !== "";
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
