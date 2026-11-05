import type { Api, SshAuthPrompt, SshConnState, SshConnectionView, SshHost, SshSyncReport, SshTestOutcome } from "./api";

type SshApi = Pick<
  Api,
  | "sshHostsList"
  | "sshHostSave"
  | "sshHostRemove"
  | "sshHostsRemoveMany"
  | "sshConfigSync"
  | "sshHostTest"
  | "sshConnect"
  | "sshDisconnect"
  | "sshConnectionsList"
  | "onSshState"
  | "onSshAuthPrompt"
  | "onSshAuthClosed"
  | "sshAuthReply"
>;

export type MockSsh = SshApi & {
  // What the next `sshConfigSync` finds in the pretend ~/.ssh/config; null for no file.
  __sshConfig(hosts: SshHost[] | null): void;
};

/** How long a mock test or connect takes, in ms. */
export const MOCK_SSH_DELAY = 300;

/**
 * The pretend outcome for a host, by a word in its alias: "denied" needs a password, "newkey" has an
 * unknown host key, "down" is unreachable, "broken" fails; anything else works.
 */
export function mockSshOutcome(alias: string): SshTestOutcome {
  if (alias.includes("denied")) return { kind: "authRequired" };
  if (alias.includes("newkey")) return { kind: "hostKeyUnknown" };
  if (alias.includes("down")) return { kind: "unreachable" };
  if (alias.includes("broken")) return { kind: "failed", message: "Connection closed by remote host" };
  return { kind: "ok" };
}

const REASON: Record<SshTestOutcome["kind"], string> = {
  ok: "exited",
  authRequired: "auth_required",
  hostKeyUnknown: "host_key_unknown",
  unreachable: "unreachable",
  failed: "exited",
};

const bad = (detail: string) => ({ code: "bad_arg" as const, detail });
const plain = (word: string) => !word.startsWith("-") && !/[\s\u0000-\u001f]/.test(word);
const option = /^[A-Za-z][A-Za-z0-9]*=\S/;

/** SSH hosts in memory, with the same checks and sync rules as the desktop commands. */
export function createMockSsh(initial: SshHost[] = []): MockSsh {
  let hosts = initial.map((h) => ({ ...h }));
  let config: SshHost[] | null = null;
  let next = 1;
  let prompts = 0;
  const states = new Map<string, { alias: string; state: SshConnState; run: number; timer?: ReturnType<typeof setTimeout> }>();
  const pending = new Map<string, { hostId: string; reply: (answer: string | null) => void }>();
  const stateFns = new Set<(v: SshConnectionView) => void>();
  const promptFns = new Set<(p: SshAuthPrompt) => void>();
  const closedFns = new Set<(id: string) => void>();
  const subscribe = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return Promise.resolve(() => void set.delete(cb));
  };
  const hostOf = (id: string): SshHost => {
    const host = hosts.find((h) => h.id === id);
    if (!host) throw { code: "not_found" as const };
    return host;
  };
  const view = (id: string): SshConnectionView => {
    const s = states.get(id);
    return { hostId: id, alias: s?.alias ?? hostOf(id).alias, state: s?.state ?? { kind: "disconnected" } };
  };
  const setState = (id: string, state: SshConnState) => {
    const s = states.get(id);
    if (!s) return;
    s.state = state;
    const v = view(id);
    for (const fn of stateFns) fn(v);
  };
  const live = (id: string) => ["connecting", "connected"].includes(states.get(id)?.state.kind ?? "");
  const closePrompt = (requestId: string, answer: string | null) => {
    const ask = pending.get(requestId);
    if (!ask) return false;
    pending.delete(requestId);
    ask.reply(answer);
    for (const fn of closedFns) fn(requestId);
    return true;
  };
  return {
    sshHostsList: async () => hosts.map((h) => ({ ...h })),
    sshHostSave: async (host) => {
      const alias = host.alias.trim();
      if (alias === "" || /\s/.test(alias) || alias.startsWith("-")) throw bad("alias");
      if (host.port === 0) throw bad("port");
      const jump = host.proxyJump?.trim() || undefined;
      if (jump !== undefined && !plain(jump)) throw bad("proxy_jump");
      const forwards = (host.localForwards ?? []).map((f) => ({ ...f, remoteHost: f.remoteHost.trim() }));
      if (forwards.some((f) => f.localPort === 0 || f.remotePort === 0 || f.remoteHost === "" || !plain(f.remoteHost))) throw bad("local_forward");
      const extra = (host.extraOptions ?? []).map((o) => o.trim()).filter((o) => o !== "");
      if (!extra.every((o) => option.test(o))) throw bad("extra_option");
      const id = host.id === "" ? `ssh-${next++}` : host.id;
      if (hosts.some((h) => h.alias === alias && h.id !== id)) throw bad("duplicate_alias");
      const timeout = host.connectTimeoutSecs;
      const stored: SshHost = {
        ...host,
        id,
        alias,
        hostName: host.hostName.trim() || alias,
        source: "manual",
        proxyJump: jump,
        forwardAgent: host.forwardAgent ?? false,
        localForwards: forwards,
        connectTimeoutSecs: timeout === undefined || timeout === null ? undefined : Math.min(120, Math.max(1, timeout)),
        extraOptions: extra,
      };
      if (stored.proxyJump === undefined) delete stored.proxyJump;
      if (stored.connectTimeoutSecs === undefined) delete stored.connectTimeoutSecs;
      hosts = hosts.some((h) => h.id === id) ? hosts.map((h) => (h.id === id ? stored : h)) : [...hosts, stored];
      return { ...stored };
    },
    sshHostRemove: async (id) => {
      if (!hosts.some((h) => h.id === id)) throw { code: "not_found" as const };
      hosts = hosts.filter((h) => h.id !== id);
    },
    sshHostsRemoveMany: async (ids) => {
      const before = hosts.length;
      hosts = hosts.filter((h) => !ids.includes(h.id));
      return before - hosts.length;
    },
    sshConfigSync: async (): Promise<SshSyncReport> => {
      const report: SshSyncReport = { added: 0, updated: 0, unchanged: 0, skipped: 0, missing: config === null, includeIgnored: false };
      for (const item of config ?? []) {
        const at = hosts.findIndex((h) => h.alias === item.alias);
        if (at < 0) {
          hosts = [...hosts, { ...item, id: `ssh-${next++}`, source: "sshConfig" }];
          report.added++;
        } else if (hosts[at].source === "manual") {
          report.skipped++;
        } else {
          const merged: SshHost = { ...item, id: hosts[at].id, source: "sshConfig" };
          if (JSON.stringify(merged) === JSON.stringify(hosts[at])) report.unchanged++;
          else {
            hosts = hosts.map((h, i) => (i === at ? merged : h));
            report.updated++;
          }
        }
      }
      return report;
    },
    sshHostTest: async (id) => {
      const outcome = mockSshOutcome(hostOf(id).alias);
      await new Promise((r) => setTimeout(r, MOCK_SSH_DELAY));
      return outcome;
    },
    sshConnect: async (id) => {
      const host = hostOf(id);
      if (live(id)) return view(id);
      const run = (states.get(id)?.run ?? 0) + 1;
      states.set(id, { alias: host.alias, state: { kind: "connecting" }, run });
      setState(id, { kind: "connecting" });
      const settle = (state: SshConnState) => {
        if (states.get(id)?.run === run) setState(id, state);
      };
      const entry = states.get(id)!;
      entry.timer = setTimeout(() => {
        const outcome = mockSshOutcome(host.alias);
        if (host.alias.includes("password")) {
          const requestId = `ask-${++prompts}`;
          pending.set(requestId, { hostId: id, reply: (answer) => settle(answer === null ? { kind: "failed", reason: "auth_required" } : { kind: "connected" }) });
          const prompt: SshAuthPrompt = { requestId, hostId: id, alias: host.alias, kind: "password", prompt: `${host.user ?? "me"}@${host.hostName}'s password: ` };
          for (const fn of promptFns) fn(prompt);
        } else if (outcome.kind === "ok") settle({ kind: "connected" });
        else settle({ kind: "failed", reason: REASON[outcome.kind] });
      }, MOCK_SSH_DELAY);
      return view(id);
    },
    sshDisconnect: async (id) => {
      const s = states.get(id);
      if (!s) {
        hostOf(id);
        return;
      }
      clearTimeout(s.timer);
      s.run++;
      for (const [requestId, ask] of [...pending]) if (ask.hostId === id) closePrompt(requestId, null);
      if (s.state.kind !== "disconnected") {
        s.state = { kind: "disconnected" };
        const v = view(id);
        for (const fn of stateFns) fn(v);
      }
    },
    sshConnectionsList: async () =>
      [...states.keys()]
        .filter((id) => hosts.some((h) => h.id === id))
        .map(view)
        .sort((a, b) => a.alias.localeCompare(b.alias)),
    onSshState: (cb) => subscribe(stateFns, cb),
    onSshAuthPrompt: (cb) => subscribe(promptFns, cb),
    onSshAuthClosed: (cb) => subscribe(closedFns, cb),
    sshAuthReply: async (requestId, answer) => {
      if (!closePrompt(requestId, answer)) throw { code: "not_found" as const };
    },
    __sshConfig: (found) => {
      config = found;
    },
  };
}
