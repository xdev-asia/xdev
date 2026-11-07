import { expect, it } from "vitest";
import { createMockApi, type SessionQuery, type SshHost } from "./api";

const host = (alias: string): SshHost => ({ id: "", alias, hostName: `${alias}.example.com`, source: "manual", forwardAgent: false, localForwards: [], extraOptions: [] });
const all = (over: Partial<SessionQuery> = {}): SessionQuery => ({ text: null, scope: { kind: "all" }, agent: null, homeId: null, sort: "lastDesc", limit: 50, ...over });

async function withHost() {
  const api = createMockApi({});
  const saved = await api.sshHostSave(host("box"));
  return { api, id: saved.id };
}

it("lists Local first and then each saved host", async () => {
  const { api, id } = await withHost();
  const list = await api.hostScopesList();
  expect(list.map((e) => e.id)).toEqual(["local", id]);
  expect(list[1]).toMatchObject({ alias: "box", label: "box", overrides: 0 });
});

it("stores overrides, reports the effective values and clears an empty entry", async () => {
  const { api, id } = await withHost();
  const view = await api.hostSettingsPut(id, { label: " Build box ", shell: "/bin/zsh", env: [{ name: "FOO", value: "1" }], history: { enabled: null, claudeHome: "~/.claude-x", codexHome: null, days: 30 } });
  expect(view.stored.label).toBe("Build box");
  expect(view.effective).toMatchObject({ label: "Build box", shell: "/bin/zsh", history: { enabled: true, claudeHome: "~/.claude-x", codexHome: "~/.codex", days: 30 } });
  expect((await api.hostScopesList())[1]).toMatchObject({ label: "Build box", overrides: 5 });
  const cleared = await api.hostSettingsPut(id, { label: null, shell: null, env: [], history: { enabled: null, claudeHome: null, codexHome: null, days: null } });
  expect(cleared.stored.label).toBeNull();
  expect(cleared.effective.label).toBe("box");
  expect((await api.hostScopesList())[1].overrides).toBe(0);
});

it("rejects what the desktop rejects", async () => {
  const { api, id } = await withHost();
  const put = (over: object) => api.hostSettingsPut(id, { label: null, shell: null, env: [], history: { enabled: null, claudeHome: null, codexHome: null, days: null }, ...over });
  await expect(put({ shell: "zsh" })).rejects.toMatchObject({ code: "bad_path" });
  await expect(put({ history: { enabled: null, claudeHome: "rel/path", codexHome: null, days: null } })).rejects.toMatchObject({ code: "bad_path" });
  await expect(put({ env: [{ name: "1BAD", value: "x" }] })).rejects.toMatchObject({ code: "bad_env" });
  await expect(put({ label: "x".repeat(65) })).rejects.toMatchObject({ code: "bad_name" });
  await expect(put({ history: { enabled: null, claudeHome: null, codexHome: null, days: 0 } })).rejects.toMatchObject({ code: "bad_arg" });
  await expect(api.hostSettingsGet("nope")).rejects.toMatchObject({ code: "not_found" });
});

it("answers a sync without a connection with remote_offline and no throw", async () => {
  const { api, id } = await withHost();
  const status = await api.hostHistorySync(id);
  expect(status.error).toMatchObject({ code: "remote_offline" });
  expect(status.lastSyncMs).toBeUndefined();
});

it("lists a host's sessions by scope all plus host, or by an ssh worktree scope", async () => {
  const { api, id } = await withHost();
  const rows = await api.agentSessions(all({ host: id }), false);
  expect(rows.map((r) => r.session.id)).toHaveLength(3);
  expect(rows.every((r) => r.session.homeId === `${id}-claude`)).toBe(true);
  const scoped = await api.agentSessions(all({ scope: { kind: "worktree", path: `ssh://${id}/srv/app` } }), false);
  expect(scoped).toHaveLength(2);
  expect(scoped.every((r) => r.worktree === `ssh://${id}/srv/app` && r.resumable)).toBe(true);
  const local = await api.agentSessions(all(), false);
  expect(local.some((r) => r.session.homeId.startsWith(id))).toBe(false);
});
