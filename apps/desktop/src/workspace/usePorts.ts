import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, LivePort, PortQuery } from "@/api";
import { startPortsPoll } from "./portsPoll";

/** The terminals of `path`, as a ports query. */
export interface PortsSource {
  /** The pty ids of a worktree's tabs. */
  ptyIds(path: string): string[];
}

/** One scan for the worktrees that have a terminal; the others have no ports. */
export async function scanPorts(api: Pick<Api, "portsScan">, source: PortsSource, paths: string[]): Promise<Record<string, LivePort[]>> {
  const queries: PortQuery[] = paths.map((path) => ({ path, ptyIds: source.ptyIds(path) })).filter((q) => q.ptyIds.length > 0);
  if (queries.length === 0) return {};
  const found = await api.portsScan(queries);
  return Object.fromEntries(found.map((w) => [w.path, w.ports]));
}

/** The live ports of `paths`, scanned every few seconds while `enabled`. */
export function usePorts(api: Api, source: PortsSource | null, paths: string[], enabled: boolean): { ports: Record<string, LivePort[]>; rescan(): Promise<void> } {
  const [ports, setPorts] = useState<Record<string, LivePort[]>>({});
  const latest = useRef({ source, paths });
  latest.current = { source, paths };
  const scan = useCallback(async () => {
    const { source: s, paths: p } = latest.current;
    if (!s) return;
    setPorts(await scanPorts(api, s, p));
  }, [api]);
  useEffect(() => {
    if (!enabled) {
      setPorts({});
      return;
    }
    return startPortsPoll(scan);
  }, [enabled, scan]);
  return { ports, rescan: scan };
}
