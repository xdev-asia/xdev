import type { WorkspacePort } from "@/api";

export type PortSections = {
  /** Ports of the worktree in front. */
  active: WorkspacePort[];
  /** Ports of the other worktrees. */
  other: WorkspacePort[];
  /** Container services and everything no worktree owns. */
  external: WorkspacePort[];
};

/** A path as it is compared: forward slashes, no trailing slash, folded on a drive path. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

export function groupPorts(ports: readonly WorkspacePort[], active: string | null): PortSections {
  const out: PortSections = { active: [], other: [], external: [] };
  for (const p of ports) {
    if (p.kind !== "workspace") out.external.push(p);
    else if (active !== null && p.worktree !== null && samePath(p.worktree, active)) out.active.push(p);
    else out.other.push(p);
  }
  return out;
}

/** The address a row shows: the origin a terminal printed, else `host:port` (IPv6 in brackets). */
export function portAddress(p: WorkspacePort): string {
  if (p.advertised) {
    try {
      return new URL(p.url).origin;
    } catch {
      // A malformed URL falls back to the plain address.
    }
  }
  const host = p.connectHost.includes(":") ? `[${p.connectHost}]` : p.connectHost;
  return `${host}:${p.port}`;
}

/** The last folder of a path. */
export function worktreeName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export type PortOwner = { kind: "worktree"; name: string } | { kind: "container" } | { kind: "unassigned" };

export function portOwner(p: WorkspacePort): PortOwner {
  if (p.kind === "workspace" && p.worktree !== null) return { kind: "worktree", name: worktreeName(p.worktree) };
  return p.kind === "container" ? { kind: "container" } : { kind: "unassigned" };
}

/** How many workspace ports the worktree in front has, and how many are outside. */
export function portCounts(ports: readonly WorkspacePort[], active: string | null): { workspace: number; external: number } {
  const g = groupPorts(ports, active);
  return { workspace: g.active.length, external: g.external.length };
}
