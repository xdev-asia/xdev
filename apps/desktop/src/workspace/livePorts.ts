import type { PortScan } from "@/api";

/** A listener a worktree's terminals own, as the card's ports chip shows it. */
export interface LivePort {
  /** The scan's id for it; what open and stop take. */
  id: string;
  port: number;
  /** Where it listens: `127.0.0.1`, `0.0.0.0`, `::1`, ... */
  address: string;
  pid: number;
  /** The program's name; none when the process table does not name it. */
  process: string | null;
}

/** The workspace ports of a scan with a known process, by worktree path. */
export function livePortsByWorktree(scan: PortScan | null): Record<string, LivePort[]> {
  const out: Record<string, LivePort[]> = {};
  for (const p of scan?.ports ?? []) {
    if (p.kind !== "workspace" || p.worktree === null || p.pid === null) continue;
    (out[p.worktree] ??= []).push({ id: p.id, port: p.port, address: p.bindHost, pid: p.pid, process: p.processName });
  }
  return out;
}
