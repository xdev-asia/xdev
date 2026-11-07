import type { Api, ApiError, HostHistoryStatus, HostScopeEntry, HostSettings, HostSettingsView, SshHost } from "./api";

type HostsApi = Pick<Api, "hostScopesList" | "hostSettingsGet" | "hostSettingsPut" | "hostHistorySync">;

/** What the mock history sync reports; the tests read it through `hostHistorySync`. */
export interface MockHostsOptions {
  /** Hosts with a live connection; a sync of any other host answers `remote_offline`. */
  connected?: () => Promise<ReadonlySet<string>>;
  now?: () => number;
}

const LABEL_MAX = 64;
const ENV_MAX = 64;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_PATH = /^[A-Za-z0-9._/+-]*$/;
const DAYS_DEFAULT = 90;

const empty = (): HostSettings => ({ label: null, shell: null, env: [], history: { enabled: null, claudeHome: null, codexHome: null, days: null } });

function reject(code: ApiError["code"], detail?: string): never {
  throw (detail === undefined ? { code } : { code, detail }) satisfies ApiError;
}

/** A path as Rust's `host_path` reads it: blank is absent, absolute (or `~/` for a home) and a safe charset. */
function path(raw: string | null, home: boolean, what: string): string | null {
  const p = raw?.trim() ?? "";
  if (p === "") return null;
  const anchored = p.startsWith("/") || (home && p.startsWith("~/"));
  const body = home && p.startsWith("~/") ? p.slice(2) : p;
  if (!anchored || !SAFE_PATH.test(body)) reject("bad_path", `${what}: ${p}`);
  return p;
}

/** The checks of `HostSettings::validated`, with the same codes. */
function validated(s: HostSettings): HostSettings {
  const label = s.label?.trim() || null;
  if (label !== null && [...label].length > LABEL_MAX) reject("bad_name", "label is too long");
  const shell = path(s.shell, false, "shell");
  if (s.env.length > ENV_MAX) reject("bad_env", "too many variables");
  for (const v of s.env) {
    if (!ENV_NAME.test(v.name)) reject("bad_env", `name: ${v.name}`);
    if (v.value.includes("\0")) reject("bad_env", `value of ${v.name}`);
  }
  const { days } = s.history;
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) reject("bad_arg", `days: ${days}`);
  return {
    label,
    shell,
    env: s.env.map((v) => ({ ...v })),
    history: { enabled: s.history.enabled, claudeHome: path(s.history.claudeHome, true, "claudeHome"), codexHome: path(s.history.codexHome, true, "codexHome"), days },
  };
}

const isEmpty = (s: HostSettings) => s.label === null && s.shell === null && s.env.length === 0 && s.history.enabled === null && s.history.claudeHome === null && s.history.codexHome === null && s.history.days === null;

const overrides = (s: HostSettings) =>
  [s.label !== null, s.shell !== null, s.env.length > 0, s.history.enabled !== null, s.history.claudeHome !== null, s.history.codexHome !== null, s.history.days !== null].filter(Boolean).length;

/** Per-host settings over the saved SSH hosts, validated like the desktop does. */
export function createMockHosts(listHosts: () => Promise<SshHost[]>, options: MockHostsOptions = {}): HostsApi {
  const stored = new Map<string, HostSettings>();
  const status = new Map<string, HostHistoryStatus>();
  const connected = options.connected ?? (async () => new Set<string>());
  const now = options.now ?? (() => Date.now());
  const find = async (id: string) => (await listHosts()).find((h) => h.id === id) ?? reject("not_found", id);
  const view = (host: SshHost): HostSettingsView => {
    const s = stored.get(host.id) ?? empty();
    return {
      hostId: host.id,
      stored: structuredClone(s),
      effective: {
        label: s.label ?? host.alias,
        shell: s.shell,
        env: structuredClone(s.env),
        history: { enabled: s.history.enabled ?? true, claudeHome: s.history.claudeHome ?? "~/.claude", codexHome: s.history.codexHome ?? "~/.codex", days: s.history.days ?? DAYS_DEFAULT },
      },
      history: structuredClone(status.get(host.id) ?? { files: 0, bytes: 0, capped: false }),
    };
  };
  return {
    async hostScopesList() {
      const hosts = await listHosts();
      const local: HostScopeEntry = { id: "local", alias: "local", label: "Local", overrides: 0 };
      return [local, ...hosts.map((h) => ({ id: h.id, alias: h.alias, label: stored.get(h.id)?.label ?? h.alias, overrides: overrides(stored.get(h.id) ?? empty()) }))];
    },
    async hostSettingsGet(hostId) {
      return view(await find(hostId));
    },
    async hostSettingsPut(hostId, settings) {
      const host = await find(hostId);
      const next = validated(settings);
      if (isEmpty(next)) stored.delete(hostId);
      else stored.set(hostId, next);
      // History off deletes the mirror.
      if (next.history.enabled === false) status.delete(hostId);
      return view(host);
    },
    async hostHistorySync(hostId) {
      const host = await find(hostId);
      const last = status.get(hostId) ?? { files: 0, bytes: 0, capped: false };
      if (!(stored.get(hostId)?.history.enabled ?? true)) return structuredClone(last);
      if (!(await connected()).has(host.id)) return { ...structuredClone(last), error: { code: "remote_offline", detail: "not connected" } };
      const synced: HostHistoryStatus = { lastSyncMs: now(), files: 3, bytes: 4096, capped: false };
      status.set(hostId, synced);
      return structuredClone(synced);
    },
  };
}
