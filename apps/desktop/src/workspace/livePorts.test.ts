import { expect, it } from "vitest";
import type { PortScan, WorkspacePort } from "@/api";
import { livePortsByWorktree } from "./livePorts";

const port = (over: Partial<WorkspacePort>): WorkspacePort => ({
  id: "localhost:1:2", bindHost: "127.0.0.1", connectHost: "localhost", port: 1, pid: 2, processName: "node", protocol: "http",
  kind: "workspace", worktree: "/w/a", evidence: "terminal", url: "http://localhost:1", advertised: false, ...over,
});
const scan = (ports: WorkspacePort[]): PortScan => ({ platform: "linux", scannedAt: 0, ports, unavailable: null, detail: null, retryIn: null });

it("groups the workspace ports that have a process by worktree", () => {
  const out = livePortsByWorktree(scan([
    port({ id: "a", port: 5173 }),
    port({ id: "b", port: 8080, worktree: "/w/b", processName: null, bindHost: "0.0.0.0", connectHost: "localhost" }),
    port({ id: "e", port: 3000, worktree: "/w/b", bindHost: "::1", connectHost: "::1" }),
    port({ id: "f", port: 4000, worktree: "/w/b", bindHost: "*", connectHost: "localhost", advertised: true, url: "https://localhost:4000/app" }),
    port({ id: "c", kind: "container", worktree: null }),
    port({ id: "d", pid: null }),
  ]));
  expect(out).toEqual({
    "/w/a": [{ id: "a", port: 5173, address: "localhost", endpoint: "localhost:5173", pid: 2, process: "node" }],
    "/w/b": [
      // A wildcard bind is shown and copied as the host to connect to, as the Ports panel does.
      { id: "b", port: 8080, address: "localhost", endpoint: "localhost:8080", pid: 2, process: null },
      { id: "e", port: 3000, address: "::1", endpoint: "[::1]:3000", pid: 2, process: "node" },
      { id: "f", port: 4000, address: "localhost", endpoint: "https://localhost:4000", pid: 2, process: "node" },
    ],
  });
});

it("is empty without a scan", () => {
  expect(livePortsByWorktree(null)).toEqual({});
});
