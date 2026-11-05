import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type SshHost } from "@/api";
import { DEMO_SEED } from "@/mockApi";
import { translate } from "@/i18n";
import { SshHostDialog } from "./ssh/SshHostDialog";
import { SshHostList } from "./ssh/SshHostList";
import { SshPage } from "./SshPage";
import { SECTIONS } from "./sections";
import { SETTING_ENTRIES } from "./catalog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const none = { forwardAgent: false, localForwards: [], extraOptions: [] };
const web: SshHost = { id: "1", alias: "web", hostName: "web.example.com", user: "deploy", port: 2222, source: "manual", ...none };
const db: SshHost = { id: "2", alias: "db", hostName: "10.0.0.5", source: "sshConfig", ...none };
const list = (hosts: SshHost[], total = hosts.length, selected: string[] = []) =>
  renderToStaticMarkup(<SshHostList hosts={hosts} total={total} selected={new Set(selected)} onToggle={() => {}} onEdit={() => {}} onRemove={() => {}} />);

it("is registered as a section with a search entry", () => {
  expect(SECTIONS.find((s) => s.id === "ssh")?.Component).toBe(SshPage);
  expect(SETTING_ENTRIES.some((e) => e.id === "ssh.hosts" && e.section === "ssh")).toBe(true);
});

it("the page shows its title, filter box, sync and add buttons", () => {
  const html = renderToStaticMarkup(<SshPage api={createMockApi(DEMO_SEED)} onChanged={() => {}} />);
  expect(html).toContain(en("ssh.title"));
  expect(html).toContain(en("ssh.search"));
  expect(html).toContain(en("ssh.sync"));
  expect(html).toContain(en("ssh.add"));
});

it("lists each host with its address and where it came from", () => {
  const html = list([web, db], 2, ["1"]);
  expect(html).toContain("web");
  expect(html).toContain("deploy@web.example.com:2222");
  expect(html).toContain(en("ssh.source.manual"));
  expect(html).toContain(en("ssh.source.config"));
  expect(html).toContain(en("ssh.select", { alias: "web" }));
  expect(html.match(/checked=""/g)?.length).toBe(1);
  expect(html.match(/data-testid="ssh-row"/g)?.length).toBe(2);
});

it("tells an empty store from a filter that matches nothing", () => {
  expect(list([], 0)).toContain(en("ssh.empty"));
  expect(list([], 0)).toContain(en("ssh.emptyHint"));
  const nothing = list([], 3);
  expect(nothing).toContain(en("ssh.noMatch"));
  expect(nothing).not.toContain(en("ssh.empty"));
});

it("the add form shows no error before a save and has the fields", () => {
  const html = renderToStaticMarkup(<SshHostDialog api={createMockApi(DEMO_SEED)} initial={null} others={[]} onSaved={() => {}} onCancel={() => {}} />);
  expect(html).toContain(en("ssh.form.newTitle"));
  for (const k of ["alias", "hostName", "user", "port", "identityFile"]) expect(html).toContain(en(`ssh.form.${k}`));
  expect(html).not.toContain(en("ssh.form.aliasBad"));
  expect(html).not.toContain(en("ssh.form.portBad"));
});

it("the form has an Advanced group, open when the host sets an advanced field", () => {
  const closed = renderToStaticMarkup(<SshHostDialog api={createMockApi(DEMO_SEED)} initial={web} others={[]} onSaved={() => {}} onCancel={() => {}} />);
  expect(closed).toContain(en("ssh.form.advanced"));
  expect(closed).toContain('aria-expanded="false"');
  for (const k of ["proxyJump", "forwardAgent", "forwards", "connectTimeout", "extraOptions"]) expect(closed).toContain(en(`ssh.form.${k}`));
  const withJump = { ...web, proxyJump: "bastion", localForwards: [{ localPort: 5432, remoteHost: "db", remotePort: 5432 }] };
  const open = renderToStaticMarkup(<SshHostDialog api={createMockApi(DEMO_SEED)} initial={withJump} others={[]} onSaved={() => {}} onCancel={() => {}} />);
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('value="bastion"');
  expect(open).toContain("5432:db:5432");
});

it("the mock store checks the advanced fields and clamps the timeout", async () => {
  const api = createMockApi(DEMO_SEED);
  const base = { id: "", hostName: "", source: "manual" as const, ...none };
  await expect(api.sshHostSave({ ...base, alias: "a", proxyJump: "a b" })).rejects.toMatchObject({ detail: "proxy_jump" });
  await expect(api.sshHostSave({ ...base, alias: "a", localForwards: [{ localPort: 0, remoteHost: "x", remotePort: 1 }] })).rejects.toMatchObject({ detail: "local_forward" });
  await expect(api.sshHostSave({ ...base, alias: "a", extraOptions: ["nope"] })).rejects.toMatchObject({ detail: "extra_option" });
  const saved = await api.sshHostSave({ ...base, alias: "a", connectTimeoutSecs: 999, extraOptions: [" A=1 ", ""], forwardAgent: true });
  expect(saved).toMatchObject({ connectTimeoutSecs: 120, extraOptions: ["A=1"], forwardAgent: true });
});

it("editing fills the form from the host", () => {
  const html = renderToStaticMarkup(<SshHostDialog api={createMockApi(DEMO_SEED)} initial={web} others={["db"]} onSaved={() => {}} onCancel={() => {}} />);
  expect(html).toContain(en("ssh.form.editTitle"));
  expect(html).toContain('value="web.example.com"');
  expect(html).toContain('value="2222"');
});

it("the mock store refuses a bad alias or port and a duplicate", async () => {
  const api = createMockApi(DEMO_SEED);
  const base = { id: "", hostName: "", source: "manual" as const, ...none };
  await expect(api.sshHostSave({ ...base, alias: "a b" })).rejects.toMatchObject({ code: "bad_arg", detail: "alias" });
  await expect(api.sshHostSave({ ...base, alias: "a", port: 0 })).rejects.toMatchObject({ detail: "port" });
  const saved = await api.sshHostSave({ ...base, alias: "web" });
  expect(saved).toMatchObject({ alias: "web", hostName: "web", source: "manual" });
  await expect(api.sshHostSave({ ...base, alias: "web" })).rejects.toMatchObject({ detail: "duplicate_alias" });
  expect(await api.sshHostsList()).toHaveLength(1);
});

it("a sync adds new aliases, updates synced ones and leaves manual hosts", async () => {
  const api = createMockApi(DEMO_SEED);
  const base = { id: "", hostName: "", source: "manual" as const, ...none };
  await api.sshHostSave({ ...base, alias: "mine", hostName: "mine.example.com" });
  expect((await api.sshConfigSync()).missing).toBe(true);

  const entry = (alias: string, hostName: string): SshHost => ({ id: "", alias, hostName, source: "sshConfig", ...none });
  api.__sshConfig([entry("mine", "theirs"), entry("web", "w1")]);
  expect(await api.sshConfigSync()).toMatchObject({ added: 1, updated: 0, skipped: 1, missing: false });
  api.__sshConfig([entry("web", "w2")]);
  expect(await api.sshConfigSync()).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
  api.__sshConfig([entry("web", "w2")]);
  expect(await api.sshConfigSync()).toMatchObject({ updated: 0, unchanged: 1 });
  const hosts = await api.sshHostsList();
  expect(hosts.find((h) => h.alias === "mine")?.hostName).toBe("mine.example.com");
  expect(hosts.find((h) => h.alias === "web")).toMatchObject({ hostName: "w2", source: "sshConfig" });
});

it("removing one or many reports how many went", async () => {
  const api = createMockApi(DEMO_SEED);
  const base = { id: "", hostName: "", source: "manual" as const, ...none };
  const a = await api.sshHostSave({ ...base, alias: "a" });
  const b = await api.sshHostSave({ ...base, alias: "b" });
  await api.sshHostSave({ ...base, alias: "c" });
  await api.sshHostRemove(a.id);
  await expect(api.sshHostRemove(a.id)).rejects.toMatchObject({ code: "not_found" });
  expect(await api.sshHostsRemoveMany([b.id, "nope"])).toBe(1);
  expect((await api.sshHostsList()).map((h) => h.alias)).toEqual(["c"]);
});
