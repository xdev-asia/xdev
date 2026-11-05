import type { Api, SshHost, SshSyncReport } from "./api";

type SshApi = Pick<Api, "sshHostsList" | "sshHostSave" | "sshHostRemove" | "sshHostsRemoveMany" | "sshConfigSync">;

export type MockSsh = SshApi & {
  // What the next `sshConfigSync` finds in the pretend ~/.ssh/config; null for no file.
  __sshConfig(hosts: SshHost[] | null): void;
};

const bad = (detail: string) => ({ code: "bad_arg" as const, detail });
const plain = (word: string) => !word.startsWith("-") && !/[\s\u0000-\u001f]/.test(word);
const option = /^[A-Za-z][A-Za-z0-9]*=\S/;

/** SSH hosts in memory, with the same checks and sync rules as the desktop commands. */
export function createMockSsh(initial: SshHost[] = []): MockSsh {
  let hosts = initial.map((h) => ({ ...h }));
  let config: SshHost[] | null = null;
  let next = 1;
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
    __sshConfig: (found) => {
      config = found;
    },
  };
}
