import type { Api, PortScan, WorkspacePort } from "./api";

type PortsApi = Pick<Api, "portsScan" | "portsStop" | "portsOpen" | "onPortsAdvertised">;

/** The id of the port the last `portsOpen` call asked for; for tests. */
let lastOpened: string | null = null;
export function lastOpenedPort(): string | null {
  return lastOpened;
}

function port(p: Partial<WorkspacePort> & Pick<WorkspacePort, "port" | "kind">): WorkspacePort {
  const pid = p.pid ?? null;
  return {
    id: `localhost:${p.port}:${pid ?? "unknown"}`,
    bindHost: "::",
    connectHost: "localhost",
    pid,
    processName: null,
    protocol: "http",
    worktree: null,
    evidence: null,
    url: `http://localhost:${p.port}`,
    advertised: false,
    ...p,
  } satisfies WorkspacePort;
}

/** Ports in memory: a dev server of the demo worktree, a container service and an outside database. */
export function createMockPorts(root: string): PortsApi {
  let ports: WorkspacePort[] = [
    port({ port: 5173, pid: 4101, processName: "node", kind: "workspace", worktree: root, evidence: "terminal", advertised: true }),
    port({ port: 8080, pid: 4102, processName: "java", kind: "container" }),
    port({ port: 5432, pid: 4103, processName: "postgres", kind: "external", protocol: "unknown", url: "http://localhost:5432" }),
  ];
  const scan = (): PortScan => ({
    platform: "windows",
    scannedAt: Date.now(),
    ports: ports.map((p) => ({ ...p })),
    unavailable: null,
    detail: null,
    retryIn: null,
  });
  return {
    async portsScan() {
      return scan();
    },
    async portsStop(_worktrees, id) {
      ports = ports.filter((p) => p.id !== id);
      return scan();
    },
    async portsOpen(id) {
      lastOpened = id;
    },
    async onPortsAdvertised() {
      return () => undefined;
    },
  };
}
