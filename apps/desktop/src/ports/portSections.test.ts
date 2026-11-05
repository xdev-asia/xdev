import { expect, it } from "vitest";
import type { WorkspacePort } from "@/api";
import { groupPorts, portAddress, portCounts, portOwner, samePath, worktreeName } from "./portSections";

function port(p: Partial<WorkspacePort> & { port: number }): WorkspacePort {
  return {
    id: `localhost:${p.port}:1`,
    bindHost: "::",
    connectHost: "localhost",
    pid: 1,
    processName: null,
    protocol: "http",
    kind: "workspace",
    worktree: null,
    evidence: null,
    url: `http://localhost:${p.port}`,
    advertised: false,
    ...p,
  };
}

it("splits ports into active, other and external", () => {
  const ports = [
    port({ port: 1, worktree: "/w/a" }),
    port({ port: 2, worktree: "/w/b" }),
    port({ port: 3, kind: "container" }),
    port({ port: 4, kind: "external" }),
  ];
  const g = groupPorts(ports, "/w/a");
  expect(g.active.map((p) => p.port)).toEqual([1]);
  expect(g.other.map((p) => p.port)).toEqual([2]);
  expect(g.external.map((p) => p.port)).toEqual([3, 4]);
  expect(portCounts(ports, "/w/a")).toEqual({ workspace: 1, external: 2 });
});

it("with no worktree in front every workspace port is in another one", () => {
  const g = groupPorts([port({ port: 1, worktree: "/w/a" })], null);
  expect(g.active).toEqual([]);
  expect(g.other).toHaveLength(1);
});

it("compares paths across slashes and, on a drive, case", () => {
  expect(samePath("C:\\Work\\A\\", "c:/work/a")).toBe(true);
  expect(samePath("/w/A", "/w/a")).toBe(false);
  expect(samePath("/w/a", "/w/ab")).toBe(false);
});

it("shows the printed origin, else host and port with IPv6 in brackets", () => {
  expect(portAddress(port({ port: 5173, advertised: true, url: "http://dev.local:5173/path" }))).toBe("http://dev.local:5173");
  expect(portAddress(port({ port: 3000 }))).toBe("localhost:3000");
  expect(portAddress(port({ port: 3000, connectHost: "::1" }))).toBe("[::1]:3000");
});

it("names the owner", () => {
  expect(portOwner(port({ port: 1, worktree: "C:\\wt\\oak" }))).toEqual({ kind: "worktree", name: "oak" });
  expect(portOwner(port({ port: 1, kind: "container" }))).toEqual({ kind: "container" });
  expect(portOwner(port({ port: 1, kind: "external" }))).toEqual({ kind: "unassigned" });
  expect(worktreeName("/a/b/")).toBe("b");
});
