import type { PortScan } from "@/api";
import { portAddress } from "@/ports/portSections";

/** A listener a worktree's terminals own, as the card's ports chip shows it. */
export interface LivePort {
  /** The scan's id for it; what open and stop take. */
  id: string;
  port: number;
  /** Where to connect: the bind host, with a wildcard (`0.0.0.0`, `::`, `*`) as `localhost`. */
  address: string;
  /** What the chip shows and copies, as the Ports panel does: a printed origin, else `host:port`. */
  endpoint: string;
  pid: number;
  /** The program's name; none when the process table does not name it. */
  process: string | null;
}

/** The workspace ports of a scan with a known process, by worktree path. */
export function livePortsByWorktree(scan: PortScan | null): Record<string, LivePort[]> {
  const out: Record<string, LivePort[]> = {};
  for (const p of scan?.ports ?? []) {
    if (p.kind !== "workspace" || p.worktree === null || p.pid === null) continue;
    (out[p.worktree] ??= []).push({ id: p.id, port: p.port, address: p.connectHost, endpoint: portAddress(p), pid: p.pid, process: p.processName });
  }
  return out;
}
