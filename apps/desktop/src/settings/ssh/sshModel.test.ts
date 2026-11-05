import { expect, it } from "vitest";
import type { SshHost } from "@/api";
import {
  EMPTY_FORM,
  endpoint,
  filterHosts,
  formOf,
  hasAdvanced,
  hostOf,
  parseForward,
  parseForwards,
  parsePort,
  parseTimeout,
  problems,
  syncLine,
  validAlias,
  validExtraOption,
} from "./sshModel";

const host = (alias: string, extra: Partial<SshHost> = {}): SshHost => ({
  id: `id-${alias}`,
  alias,
  hostName: `${alias}.example.com`,
  source: "manual",
  forwardAgent: false,
  localForwards: [],
  extraOptions: [],
  ...extra,
});

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
  const form = { ...EMPTY_FORM, alias: " web ", hostName: " ", user: " me ", port: "2222", identityFile: "" };
  expect(hostOf(form, "")).toEqual({
    id: "",
    alias: "web",
    hostName: "web",
    source: "manual",
    user: "me",
    port: 2222,
    forwardAgent: false,
    localForwards: [],
    extraOptions: [],
  });
  const saved = host("web", { user: "me", port: 2222, identityFile: "~/.ssh/k" });
  expect(formOf(saved)).toEqual({ ...EMPTY_FORM, alias: "web", hostName: "web.example.com", user: "me", port: "2222", identityFile: "~/.ssh/k" });
  expect(formOf(null)).toEqual(EMPTY_FORM);
});

it("words the sync result", () => {
  const base = { added: 2, updated: 1, unchanged: 3, skipped: 0, missing: false, includeIgnored: false };
  expect(syncLine(base)).toEqual({ key: "ssh.sync.done", vars: { added: 2, updated: 1, unchanged: 3, skipped: 0 } });
  expect(syncLine({ ...base, missing: true }).key).toBe("ssh.sync.missing");
});

it("reads the connect timeout as none, 1 to 120, or invalid", () => {
  expect(parseTimeout("")).toBeUndefined();
  expect(parseTimeout(" 15 ")).toBe(15);
  expect(parseTimeout("1")).toBe(1);
  expect(parseTimeout("120")).toBe(120);
  for (const bad of ["0", "121", "-5", "1.5", "ten"]) expect(parseTimeout(bad)).toBe(false);
});

it("reads local forwards one per line", () => {
  expect(parseForward("5432:db.internal:5432")).toEqual({ localPort: 5432, remoteHost: "db.internal", remotePort: 5432 });
  expect(parseForward(" 8080:[::1]:80 ")).toEqual({ localPort: 8080, remoteHost: "::1", remotePort: 80 });
  for (const bad of ["", "5432", "5432:db", "0:db:1", "1:db:70000", "1:a b:2", "1:-x:2", "x:db:1", "1:::1:2"]) expect(parseForward(bad), bad).toBe(false);
  expect(parseForwards("")).toEqual([]);
  expect(parseForwards("1:a:2\n\n 3:b:4 \r\n")).toEqual([
    { localPort: 1, remoteHost: "a", remotePort: 2 },
    { localPort: 3, remoteHost: "b", remotePort: 4 },
  ]);
  expect(parseForwards("1:a:2\nnope")).toBe(false);
});

it("takes extra options as Key=Value only", () => {
  for (const ok of ["ServerAliveInterval=30", "SetEnv=A=b c", "X11Forwarding=no"]) expect(validExtraOption(ok), ok).toBe(true);
  for (const bad of ["", "NoEquals", "=v", "Key=", "Key= ", "1Key=v", "Bad-Key=v", "Key=a\u0007"]) expect(validExtraOption(bad), bad).toBe(false);
});

it("names the problem of each advanced field", () => {
  const ok = { ...EMPTY_FORM, alias: "web" };
  expect(problems({ ...ok, proxyJump: "a b" }, [])).toEqual({ proxyJump: "proxyJump" });
  expect(problems({ ...ok, proxyJump: "-oProxyCommand=x" }, [])).toEqual({ proxyJump: "proxyJump" });
  expect(problems({ ...ok, forwards: "1:a" }, [])).toEqual({ forwards: "forwards" });
  expect(problems({ ...ok, connectTimeout: "500" }, [])).toEqual({ connectTimeout: "connectTimeout" });
  expect(problems({ ...ok, extraOptions: "A=1\nnope" }, [])).toEqual({ extraOptions: "extraOptions" });
  expect(problems({ ...ok, proxyJump: "me@jump:22,b", forwards: "1:a:2", connectTimeout: "5", extraOptions: "A=1" }, [])).toEqual({});
});

it("carries the advanced fields from the form to the host and back", () => {
  const form = {
    ...EMPTY_FORM,
    alias: "web",
    proxyJump: " bastion ",
    forwardAgent: true,
    forwards: "5432:db:5432\n8080:[::1]:80",
    connectTimeout: "20",
    extraOptions: " ServerAliveInterval=30 \n\n",
  };
  const h = hostOf(form, "id");
  expect(h).toMatchObject({
    proxyJump: "bastion",
    forwardAgent: true,
    localForwards: [
      { localPort: 5432, remoteHost: "db", remotePort: 5432 },
      { localPort: 8080, remoteHost: "::1", remotePort: 80 },
    ],
    connectTimeoutSecs: 20,
    extraOptions: ["ServerAliveInterval=30"],
  });
  expect(formOf(h)).toMatchObject({
    proxyJump: "bastion",
    forwardAgent: true,
    forwards: "5432:db:5432\n8080:[::1]:80",
    connectTimeout: "20",
    extraOptions: "ServerAliveInterval=30",
  });
  expect(hasAdvanced(formOf(h))).toBe(true);
  expect(hasAdvanced(EMPTY_FORM)).toBe(false);
});
