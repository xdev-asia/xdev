import { expect, it } from "vitest";
import type { SshHost } from "@/api";
import { EMPTY_FORM, endpoint, filterHosts, formOf, hostOf, parsePort, problems, syncLine, validAlias } from "./sshModel";

const host = (alias: string, extra: Partial<SshHost> = {}): SshHost => ({ id: `id-${alias}`, alias, hostName: `${alias}.example.com`, source: "manual", ...extra });

it("shows user, host and port as far as they are set", () => {
  expect(endpoint(host("web"))).toBe("web.example.com");
  expect(endpoint(host("web", { user: "deploy", port: 2222 }))).toBe("deploy@web.example.com:2222");
  expect(endpoint(host("web", { port: 22 }))).toBe("web.example.com:22");
});

it("filters by alias, address, user and port, ignoring case", () => {
  const all = [host("web", { user: "Deploy" }), host("db", { port: 5432 }), host("cache")];
  expect(filterHosts(all, "").length).toBe(3);
  expect(filterHosts(all, "  ").length).toBe(3);
  expect(filterHosts(all, "WEB").map((h) => h.alias)).toEqual(["web"]);
  expect(filterHosts(all, "deploy@").map((h) => h.alias)).toEqual(["web"]);
  expect(filterHosts(all, ":5432").map((h) => h.alias)).toEqual(["db"]);
  expect(filterHosts(all, "example.com").length).toBe(3);
  expect(filterHosts(all, "nothing")).toEqual([]);
});

it("checks the alias the way the desktop does", () => {
  for (const ok of ["web", "web-1", "user@box"]) expect(validAlias(ok)).toBe(true);
  for (const bad of ["", "a b", "a\tb", "-oProxyCommand=x"]) expect(validAlias(bad)).toBe(false);
});

it("reads the port as none, a number in range, or invalid", () => {
  expect(parsePort("")).toBeUndefined();
  expect(parsePort(" 22 ")).toBe(22);
  expect(parsePort("1")).toBe(1);
  expect(parsePort("65535")).toBe(65535);
  for (const bad of ["0", "65536", "-1", "2.5", "ssh", "1e3"]) expect(parsePort(bad)).toBe(false);
});

it("names the problem of each field", () => {
  expect(problems(EMPTY_FORM, [])).toEqual({ alias: "alias" });
  expect(problems({ ...EMPTY_FORM, alias: "a b" }, [])).toEqual({ alias: "alias" });
  expect(problems({ ...EMPTY_FORM, alias: "web" }, ["web"])).toEqual({ alias: "aliasTaken" });
  expect(problems({ ...EMPTY_FORM, alias: " web ", port: "70000" }, ["db"])).toEqual({ port: "port" });
  expect(problems({ ...EMPTY_FORM, alias: "web", port: "22" }, [])).toEqual({});
});

it("turns a form into a manual host and back", () => {
  const form = { alias: " web ", hostName: " ", user: " me ", port: "2222", identityFile: "" };
  expect(hostOf(form, "")).toEqual({ id: "", alias: "web", hostName: "web", source: "manual", user: "me", port: 2222 });
  const saved = host("web", { user: "me", port: 2222, identityFile: "~/.ssh/k" });
  expect(formOf(saved)).toEqual({ alias: "web", hostName: "web.example.com", user: "me", port: "2222", identityFile: "~/.ssh/k" });
  expect(formOf(null)).toEqual(EMPTY_FORM);
});

it("words the sync result", () => {
  const base = { added: 2, updated: 1, unchanged: 3, skipped: 0, missing: false, includeIgnored: false };
  expect(syncLine(base)).toEqual({ key: "ssh.sync.done", vars: { added: 2, updated: 1, unchanged: 3, skipped: 0 } });
  expect(syncLine({ ...base, missing: true }).key).toBe("ssh.sync.missing");
});
