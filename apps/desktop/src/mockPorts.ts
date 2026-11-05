import type { Api, ApiError, LivePort } from "./api";

type PortsApi = Pick<Api, "portsScan" | "portStop">;

/** Two listeners for any worktree that has a terminal; stopping one removes it. */
export function createMockPorts(): PortsApi {
  const stopped = new Set<number>();
  const all = (path: string): LivePort[] => [
    { port: 5173, address: "127.0.0.1", pid: 4100 + path.length, process: "node" },
    { port: 8080, address: "0.0.0.0", pid: 5100 + path.length, process: null },
  ];
  return {
    portsScan: async (queries) =>
      queries.map((q) => ({
        path: q.path,
        ports: q.ptyIds.length === 0 ? [] : all(q.path).filter((p) => !stopped.has(p.pid)),
      })),
    portStop: (ptyIds, pid, confirmed) => {
      if (!confirmed) return Promise.reject({ code: "needs_approval" } satisfies ApiError);
      if (ptyIds.length === 0) return Promise.reject({ code: "port_unknown" } satisfies ApiError);
      stopped.add(pid);
      return Promise.resolve();
    },
  };
}
